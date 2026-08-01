// gh-project-sync / advance — the EVENT-driven half of the docs <-> GitHub Project sync.
//
// Advances Project (v2) items to a target column (default: the deploy line, e.g. "Deployed to Dev")
// when a deploy/merge event fires — the one automated move past the deploy line, which the reconciler
// (reconcile.mjs) never touches. Later columns (e.g. "Ready for prod", "Done") are set MANUALLY.
//
// It resolves WHICH issues to advance from a merged PR: given a commit SHA (or a PR number), it finds
// the associated PR(s), parses title/body for tracking-issue references (`#123`, `Closes #123`,
// `Refs #123`), and for each referenced issue on the project sets the target column — FORWARD ONLY
// (never backward). Safe to re-run; a no-op when nothing references a tracked issue.
//
// Config: reads ./gh-project-sync.config.json (override with GH_PROJECT_SYNC_CONFIG).
//
// Usage:
//   node <plugin>/scripts/advance.mjs --column "Deployed to Dev" --sha <merge-sha>
//   node <plugin>/scripts/advance.mjs --column "Deployed to Dev" --pr 123
//
// Requires GH_TOKEN with `project` scope (the default Actions GITHUB_TOKEN cannot write org Projects v2 —
// set a repo/org secret and pass it as GH_TOKEN). Missing token => warn + exit 0 (non-fatal).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

function loadConfig() {
  const path = process.env.GH_PROJECT_SYNC_CONFIG || "gh-project-sync.config.json";
  const abs = isAbsolute(path) ? path : join(process.cwd(), path);
  if (!existsSync(abs)) {
    console.error(`gh-project-sync: config not found at ${abs}`);
    process.exit(1);
  }
  const c = JSON.parse(readFileSync(abs, "utf8"));
  c.columnRank = c.columnRank || { Todo: 0, "In progress": 1, "Deployed to Dev": 2, "Ready for prod": 3, Done: 4 };
  c.deployLine = c.deployLine || "Deployed to Dev";
  for (const k of ["owner", "repo", "projectNumber"]) {
    if (c[k] === undefined) { console.error(`gh-project-sync: config missing "${k}"`); process.exit(1); }
  }
  return c;
}

const CFG = loadConfig();
const OWNER = CFG.owner;
const REPO = CFG.repo;
const PROJECT_NUMBER = CFG.projectNumber;
const COLUMN_RANK = CFG.columnRank;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function gh(args, { json = false, allowFail = false } = {}) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return json ? JSON.parse(out) : out.trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}
function referencedIssues(pr) {
  const text = `${pr.title || ""}\n${pr.body || ""}`;
  const nums = new Set();
  for (const m of text.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref[s]?)?\s*#(\d+)/gi)) nums.add(Number(m[1]));
  return [...nums];
}

function main() {
  const column = arg("--column") || CFG.deployLine;
  const sha = arg("--sha");
  const prNum = arg("--pr");
  if (!column || COLUMN_RANK[column] === undefined) {
    console.error(`--column must be one of: ${Object.keys(COLUMN_RANK).join(", ")}`);
    process.exit(1);
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.warn("No GH_TOKEN/GITHUB_TOKEN set — skipping project advance (configure a project-scoped token secret).");
    return;
  }

  let prs = [];
  if (prNum) {
    const pr = gh(["pr", "view", prNum, "--repo", REPO, "--json", "title,body,number"], { json: true, allowFail: true });
    if (pr) prs = [pr];
  } else if (sha) {
    const found = gh(["api", `repos/${REPO}/commits/${sha}/pulls`, "-q", ".[] | {number, title, body}"], { allowFail: true });
    if (found) prs = found.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const issueNums = [...new Set(prs.flatMap(referencedIssues))];

  const projectId = gh(["project", "view", String(PROJECT_NUMBER), "--owner", OWNER, "--format", "json"], { json: true }).id;
  const fields = gh(["project", "field-list", String(PROJECT_NUMBER), "--owner", OWNER, "--format", "json", "-L", "50"], { json: true }).fields;
  const statusField = fields.find((f) => f.name === "Status");
  const optId = statusField?.options?.find((o) => o.name === column)?.id;
  const items = gh(["project", "item-list", String(PROJECT_NUMBER), "--owner", OWNER, "--format", "json", "-L", "500"], { json: true }).items;
  const byNumber = new Map(items.filter((it) => it.content?.type === "Issue").map((it) => [it.content.number, it]));
  const targetRank = COLUMN_RANK[column];

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
      console.warn(`${label}: failed to set "${column}": ${e.message}`);
    }
  };

  if (!issueNums.length) console.log(`No tracking-issue refs from ${prNum ? `#${prNum}` : sha || "(no ref)"}.`);
  for (const n of issueNums) {
    const item = byNumber.get(n);
    if (item) advance(item, `#${n}`);
  }
}

main();
