// gh-project-sync / advance — the EVENT-driven half of the docs <-> GitHub Project sync.
//
// Advances Project (v2) items to a target column (default: the deploy line, e.g. "Deployed to Dev")
// when a deploy/merge event fires — the one automated move past the deploy line, which the reconciler
// (reconcile.mjs) never touches. Later columns (e.g. "Ready for prod", "Done") are set MANUALLY.
//
// It resolves WHICH issues to advance from a merged PR: given a commit SHA (or a PR number), it finds
// the associated PR(s) and reads their title/body for tracking-issue references. Only an ADVANCING
// keyword moves an issue (see ADVANCE_KEYWORDS); a reference keyword just links it. Moves are FORWARD
// ONLY (never backward). Safe to re-run.
//
// Config: reads ./gh-project-sync.config.json (override with GH_PROJECT_SYNC_CONFIG).
//
// Usage:
//   node <plugin>/scripts/advance.mjs --column "Deployed to Dev" --sha <merge-sha>
//   node <plugin>/scripts/advance.mjs --column "Deployed to Dev" --pr 123
//   node <plugin>/scripts/advance.mjs --explain --pr 123     # what WOULD move; no writes, repo read only
//
// Tokens:
//   GH_TOKEN   — `project` scope, for the org Project (the default Actions GITHUB_TOKEN cannot write
//                org Projects v2). Missing => warn + exit 0.
//   REPO_TOKEN — repo read, for resolving PRs and their files (in Actions: the default GITHUB_TOKEN).
//                Falls back to the ambient credential for local runs. A project-scoped token often
//                CANNOT read a private repo, and GitHub answers 404 for that — which used to resolve
//                zero PRs and exit green on every run.
//
// KNOWN GAP — a failed deploy followed by a roll-forward strands the board. Only the PR(s) on THE
// DEPLOYED SHA are inspected: if PR A (`Addresses #N`) fails to deploy and PR B fixes it without
// repeating the keyword, no run ever sees #N. Repeat the advancing ref in roll-forward PRs.

import { pathToFileURL } from "node:url";
import { loadConfig, gh, fetchBoardItems, fetchFields, fetchProjectId, DEFAULTS } from "./lib.mjs";

// ⭐ TWO CLASSES OF KEYWORD. `Refs` used to advance, so it had to mean both "related to #N" and
// "shipped #N" — and every false advance upstream (a PR drafting stories, a docs-only runbook, an
// analysis script) was that conflation. Now:
//   ADVANCING      — Addresses, plus GitHub's closers Closes/Fixes/Resolves: asserts the work is IN this PR.
//   REFERENCE-ONLY — Refs, See, Related to: links the issue, asserts nothing, never advances.
// `Addresses` is not a GitHub auto-close keyword, so it moves the board without closing the issue.
// ⚠️ `address(?:e[sd])?`, not `addresses?` — the `?` binds to the last character only.
const ADVANCE_KEYWORDS = "address(?:e[sd])?|closes?|closed|fix(?:e[sd])?|resolves?|resolved";
const REFERENCE_ONLY_KEYWORDS = "refs?|references?|referenced|see|related\\s+to";

// The keyword is REQUIRED and must sit against the number. A bare `#N` is not a reference: PR prose is
// full of them (`(#633, merged in #643)`, `GitHub Project (#6)` — a project number, not an issue).
// "Fixing #640" does not match either, since `fix(?:e[sd])?` is not followed by `#`.
const buildRefRe = (keywords) => new RegExp(`\\b(?:${keywords})\\s*:?\\s*((?:#\\d+(?:\\s*(?:,|and)\\s*)?)+)`, "gi");
const ADVANCE_REF_RE = buildRefRe(ADVANCE_KEYWORDS);
const REFERENCE_ONLY_RE = buildRefRe(REFERENCE_ONLY_KEYWORDS);

// Drop fenced blocks and inline code spans before matching. A PR that DOCUMENTS the convention has to
// spell the keywords out; a real trailer is never written inside backticks.
// ⚠️ Plain prose ("…genuinely fixed #712") still matches and cannot be fixed in a regex — that is what
// --explain is for.
export function stripCodeSpans(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ") // fenced blocks first — they can contain lone backticks
    .replace(/``[^`]*``/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

function issuesMatching(text, re) {
  const nums = new Set();
  for (const m of text.matchAll(re)) {
    for (const n of m[1].matchAll(/#(\d+)/g)) nums.add(Number(n[1])); // one keyword can carry a list
  }
  return [...nums];
}

const prText = (pr) => stripCodeSpans(`${pr.title || ""}\n${pr.body || ""}`);

/** Issues this PR claims to have SHIPPED — the only ones eligible to move to the deploy line. */
export function advancingIssues(pr) {
  return issuesMatching(prText(pr), ADVANCE_REF_RE);
}

/** Issues merely REFERENCED — reported, never advanced. Named both ways, the stronger claim wins. */
export function referenceOnlyIssues(pr) {
  const advancing = new Set(advancingIssues(pr));
  return issuesMatching(prText(pr), REFERENCE_ONLY_RE).filter((n) => !advancing.has(n));
}

// A PR confined to planning/tracking docs ships nothing testable, so it never moves an item past the
// deploy line — a backstop to the keyword split, failing in the opposite direction. FAILS OPEN: an empty
// or unknown file list is "code-bearing", since skipping on unknown would be a silent green no-op.
export function isPlanningOnlyPr(files, prefixes = DEFAULTS.planningOnlyPrefixes) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) => typeof f === "string" && prefixes.some((p) => f.startsWith(p)));
}

// Flatten `gh api --paginate --slurp .../pulls/{n}/files`. ⚠️ The field is `filename`, not `path` —
// jq does not error on a missing field, it yields blanks, which would make the guard never fire.
export function pullFilePaths(pages) {
  if (!Array.isArray(pages)) return null;
  return pages
    .flat()
    .map((f) => (f && typeof f === "object" ? f.filename : undefined))
    .filter((p) => typeof p === "string" && p.length > 0);
}

// ---- I/O ---------------------------------------------------------------------
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function prFiles(cfg, prNumber, token) {
  try {
    // Paginated: the un-paginated form caps at 100 files, which could hide code behind planning files.
    const pages = gh(["api", "--paginate", "--slurp", `repos/${cfg.repo}/pulls/${prNumber}/files`], { json: true, token });
    return pullFilePaths(pages);
  } catch (e) {
    console.warn(`  Could not list files for PR #${prNumber} (${e.message}) — treating it as code-bearing.`);
    return null;
  }
}

function explain(cfg, prNum, token) {
  if (!prNum) {
    console.error("--explain needs --pr <number>");
    process.exit(1);
  }
  let pr;
  try {
    pr = gh(["pr", "view", String(prNum), "--repo", cfg.repo, "--json", "title,body,number"], { json: true, token });
  } catch (e) {
    console.error(`Could not read PR #${prNum}: ${e.message}`);
    process.exit(1);
  }
  const prefixes = cfg.planningOnlyPrefixes;
  const files = prFiles(cfg, pr.number, token);
  const planning = isPlanningOnlyPr(files, prefixes);
  const advancing = advancingIssues(pr);
  const refOnly = referenceOnlyIssues(pr);

  console.log(`PR #${pr.number} — ${pr.title}`);
  console.log(
    `  files: ${files ? `${files.length} changed` : "could not be determined"}` +
      (planning ? ` — PLANNING-ONLY (all under ${prefixes.join(", ")})` : ""),
  );
  if (planning) console.log("  WOULD ADVANCE: nothing — the file guard skips this PR regardless of keywords.");
  else console.log(`  WOULD ADVANCE: ${advancing.length ? advancing.map((n) => `#${n}`).join(", ") : "nothing"}`);
  console.log(`  reference-only (linked, not advanced): ${refOnly.length ? refOnly.map((n) => `#${n}`).join(", ") : "none"}`);
  if (!planning && advancing.length) {
    console.log(
      "\n  ⚠️ Check that every issue above is one this PR actually SHIPS. If one is only being discussed, " +
        're-word it as "Refs #N" — an advancing keyword can appear by accident in ordinary prose ' +
        '("…fixed #712"). Quoting a trailer inside `backticks` is safe.',
    );
  }
  // Non-zero when something would advance, so it can gate a merge.
  process.exit(!planning && advancing.length ? 1 : 0);
}

function main() {
  const cfg = loadConfig(["owner", "repo", "projectNumber"]);
  const COLUMN_RANK = cfg.columnRank;
  const REPO_TOKEN = process.env.REPO_TOKEN || null;
  const column = arg("--column") || cfg.deployLine;
  const sha = arg("--sha");
  const prNum = arg("--pr");

  // Dry-run inspection short-circuits everything below: no column, no project token, no writes.
  if (process.argv.includes("--explain")) return explain(cfg, prNum, REPO_TOKEN);

  // `in`, not truthiness: the first column's rank is 0.
  if (!(column in COLUMN_RANK)) {
    console.error(`--column must be one of: ${Object.keys(COLUMN_RANK).join(", ")}`);
    process.exit(1);
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.warn("No GH_TOKEN/GITHUB_TOKEN set — skipping project advance (configure a project-scoped token secret).");
    return;
  }

  let prs = [];
  try {
    if (prNum) {
      prs = [gh(["pr", "view", prNum, "--repo", cfg.repo, "--json", "title,body,number"], { json: true, token: REPO_TOKEN })];
    } else if (sha) {
      const found = gh(["api", `repos/${cfg.repo}/commits/${sha}/pulls`, "-q", ".[] | {number, title, body}"], { token: REPO_TOKEN });
      if (found) prs = found.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
  } catch (e) {
    // A lookup ERROR is not "this commit has no PR" (a direct push legitimately returns an empty list).
    // Swallowing it is how the upstream copy advanced nothing, green, for its first several runs.
    console.error(`Could not resolve the PR for ${prNum ? `#${prNum}` : sha}: ${e.message}`);
    console.error("No issue can be advanced. A 404 here means the token cannot read the repo — set REPO_TOKEN to a repo-read token.");
    process.exit(1);
  }

  const codeBearingPrs = [];
  for (const pr of prs) {
    const files = prFiles(cfg, pr.number, REPO_TOKEN);
    if (isPlanningOnlyPr(files, cfg.planningOnlyPrefixes)) {
      console.log(
        `  PR #${pr.number} is PLANNING-ONLY (${files.length} file(s), all under ${cfg.planningOnlyPrefixes.join(", ")}) — ` +
          "not advancing anything it references.",
      );
      continue;
    }
    codeBearingPrs.push(pr);
  }
  const issueNums = [...new Set(codeBearingPrs.flatMap(advancingIssues))];
  const refOnlyNums = [...new Set(codeBearingPrs.flatMap(referenceOnlyIssues))].filter((n) => !issueNums.includes(n));

  const projectId = fetchProjectId(cfg);
  const statusField = fetchFields(cfg).find((f) => f.name === "Status");
  const optId = statusField?.options?.find((o) => o.name === column)?.id;

  // Fail HERE, not at every item-edit. A renamed board column used to send an empty option id to each
  // advance, each failure was swallowed, and the job stayed green for days while nothing moved.
  if (!statusField) {
    console.error(`Project #${cfg.projectNumber} has no "Status" field — cannot advance anything.`);
    process.exit(1);
  }
  if (!optId) {
    const have = (statusField.options || []).map((o) => `"${o.name}"`).join(", ") || "(none)";
    console.error(
      `Status option "${column}" does not exist on project #${cfg.projectNumber}. Available: ${have}.\n` +
        'The board was very likely renamed. Update "columnRank"/"deployLine" in gh-project-sync.config.json ' +
        "and the --column argument in the workflow to match.",
    );
    process.exit(1);
  }

  const items = fetchBoardItems(cfg);
  const trackedItems = items.filter((it) => it.content?.type === "Issue");
  const byNumber = new Map(trackedItems.map((it) => [it.content.number, it]));
  const targetRank = COLUMN_RANK[column];

  // State the inputs on every run — a run that changes nothing is equally the signature of a board this
  // token cannot read.
  const list = (ns) => (ns.length ? ns.map((n) => `#${n}`).join(", ") : "none");
  console.log(
    `Resolved ${prs.length} PR(s)${prs.length ? ` (${prs.map((p) => `#${p.number}`).join(", ")})` : ""}; ` +
      `advancing refs: ${list(issueNums)}; reference-only: ${list(refOnlyNums)}; ` +
      `board items visible: ${trackedItems.length}/${items.length}.`,
  );
  if (refOnlyNums.length) {
    console.log(
      `  Reference-only (NOT advanced, by design): ${list(refOnlyNums)}. A reference keyword (Refs / See / ` +
        'Related to) links an issue without claiming the PR ships it. If it does, word it "Addresses #N".',
    );
  }
  if (items.length && !trackedItems.length) {
    console.warn(
      `Project #${cfg.projectNumber} returned ${items.length} row(s), none carrying readable issue content — ` +
        "the project token can list the board but not read the issues it links to. Give it repo read.",
    );
  }

  let failed = 0;
  const advance = (item, label) => {
    const curRank = COLUMN_RANK[item.status] ?? -1;
    if (curRank >= targetRank) {
      console.log(`${label}: already at "${item.status}" (>= "${column}") — leaving.`);
      return;
    }
    try {
      gh(["project", "item-edit", "--project-id", projectId, "--id", item.id, "--field-id", statusField.id, "--single-select-option-id", optId]);
      console.log(`${label}: "${item.status || "—"}" -> "${column}"`);
    } catch (e) {
      failed += 1;
      console.error(`${label}: failed to set "${column}": ${e.message}`);
    }
  };

  if (!issueNums.length) {
    console.log(`No advancing refs from ${prNum ? `#${prNum}` : sha || "(no ref)"} (PRs inspected: ${list(prs.map((p) => p.number))}).`);
    if (prs.length) {
      console.log(
        'An advancing reference counts only when the keyword sits directly against the number — "Addresses #N", ' +
          '"Closes #N", "Fixes #N". Prose like "…reported in #N" and "Refs #N" are ignored by design.',
      );
    }
  }
  for (const n of issueNums) {
    const item = byNumber.get(n);
    if (item) { advance(item, `#${n}`); continue; }
    console.warn(
      `#${n}: referenced by the merged PR but not among the ${trackedItems.length} board item(s) visible to this ` +
        "token — not advanced. " +
        (trackedItems.length
          ? `Add it to project #${cfg.projectNumber} if it should be tracked.`
          : "No board items are readable at all, so this is a token problem, not a missing item."),
    );
  }

  // A rejected write fails the job. Green must mean the board says what this run intended.
  if (failed) {
    console.error(`${failed} board update(s) failed — the board does NOT reflect this deploy.`);
    process.exit(1);
  }
}

// Only run when invoked as a script — lets tests import the matchers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
