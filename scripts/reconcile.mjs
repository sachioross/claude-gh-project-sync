// gh-project-sync / reconcile — the RECONCILER half of the docs <-> GitHub Project sync.
//
// Joins local markdown planning/story docs (the spec/content source of truth: rich, versioned,
// agent-edited) with a GitHub Project v2 board (the tracking/status source of truth: visible,
// PR-linked). The two are bridged by a stable `sync-id` (by default the doc's filename stem),
// stored in BOTH the doc (an `Issue: #N` header line) and the issue body (a `<!-- sync-id: ... -->`
// marker), so the join survives renames and re-runs.
//
// OWNERSHIP ZONES (why this is safe to run repeatedly):
//   - Reconciler-managed band: Todo <-> In progress. Driven by the doc's status.
//   - Event-managed (NOT touched here): everything at/after the "deploy line" (e.g. Deployed to Dev,
//     Ready for prod, Done). advance.mjs moves items to the deploy line on a deploy event; later
//     columns are set manually. The reconciler NEVER pulls an item backward across the deploy line:
//     once past it, that item is a high-water mark this script leaves alone. An item in a column the
//     config does not know is HELD too.
//
// DEFAULT = DRY RUN. Zero writes, prints a mapping report. Pass --execute to apply.
//
// Config: reads ./gh-project-sync.config.json from the current repo (override path with
// GH_PROJECT_SYNC_CONFIG=/path/to/config.json). See templates/gh-project-sync.config.json.
//
// Usage (from the target repo root; requires `gh` authed with `project` scope):
//   node <plugin>/scripts/reconcile.mjs                          # dry-run report (no writes)
//   node <plugin>/scripts/reconcile.mjs --execute                # apply: create/link issues, reconcile status
//   node <plugin>/scripts/reconcile.mjs --link-candidates --execute   # also auto-link fuzzy title matches

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, gh, fetchBoardItems, fetchFields, fetchProjectId } from "./lib.mjs";

// ---- pure helpers (exported for tests) --------------------------------------

// best-effort enum from a free-form `Status:` prose line (fallback only)
export function normalizeProse(prose, knownStatus) {
  if (!prose) return null;
  const lead = prose.replace(/^[*_\s]+/, "").match(/^([a-z][a-z-]+)/i);
  if (lead && knownStatus.has(lead[1].toLowerCase())) return lead[1].toLowerCase();
  const p = prose.toLowerCase();
  if (/\b(complete|done|shipped|merged)\b/.test(p)) return "done";
  if (/\bsuperseded\b/.test(p)) return "superseded";
  if (/\bblocked\b/.test(p)) return "blocked";
  if (/\b(review|implemented|in-review|ready-for-review)\b/.test(p)) return "review";
  if (/\bin-progress\b/.test(p)) return "in-progress";
  if (/\bready-for-dev\b/.test(p)) return "ready-for-dev";
  if (/\bbacklog\b/.test(p)) return "backlog";
  return null;
}

// ⭐ THE ENUMERATION IS THE UNION OF DOC FILES AND STATUS-MAP KEYS — never just the files. With the map
// used only as a lookup, an entry with no `<sync-id>.md` got no row, no warning and no count: the declared
// source of truth could not put a story on the report. A map-only entry is a real story with no spec file
// yet; once linked by its marker it reconciles like any other, unlinked it is reported as `unfiled`.
// Roll-up keys (`epic-7: in-progress`) summarise their children and are skipped — they would otherwise be
// permanent `unfiled` rows nobody can clear.
export function mergeStories(fileStories, statusMap, { groupRe = /^(\d+)-/, rollupRe = null } = {}) {
  const byId = new Map(fileStories.map((f) => [f.syncId, f]));
  const merged = [...fileStories];
  for (const [syncId, mapStatus] of statusMap) {
    if (byId.has(syncId)) continue;
    if (rollupRe && rollupRe.test(syncId)) continue;
    merged.push({
      syncId,
      group: (syncId.match(groupRe) || [])[1] || "?",
      title: syncId, // a report label only — never an issue title, never fed to the fuzzy matcher
      status: mapStatus,
      source: "map",
      drift: null,
      prose: "",
      issue: null,
      path: null,
      hasFile: false,
    });
  }
  return merged.sort((a, b) => a.syncId.localeCompare(b.syncId, undefined, { numeric: true }));
}

// Merge the status maps of several sources. The first source that declares an id wins, and every id the
// sources disagree on is returned as a conflict — two yamls drifting apart is exactly the kind of silent
// divergence the report exists to surface.
export function combineStatusMaps(maps) {
  const map = new Map();
  const seen = new Map(); // id -> [status per declaring source]
  for (const m of maps) {
    for (const [id, status] of m) {
      if (!map.has(id)) map.set(id, status);
      seen.set(id, [...(seen.get(id) || []), status]);
    }
  }
  const conflicts = [...seen].filter(([, ss]) => new Set(ss).size > 1).map(([id, ss]) => ({ id, statuses: ss }));
  return { map, conflicts };
}

// Decide what this run would do about one story. Free of I/O so every branch can be asserted.
export function decideAction({ story, linked, wantColumn, candidate, linkCandidates = false, cfg }) {
  const COLUMN_RANK = cfg.columnRank;
  if (linked) {
    // ⭐ AN UNRECOGNIZED COLUMN IS HELD, NOT RECONCILED. Ranking it -1 treats "unknown position" as "the
    // very beginning" — upstream, a renamed deploy column made this script ready to drag items BACKWARD.
    if (linked.status && !(linked.status in COLUMN_RANK)) {
      return {
        action: "hold",
        detail: `#${linked.number} at "${linked.status}" (column not recognized — held; update "columnRank" if the board was renamed)`,
      };
    }
    const curRank = COLUMN_RANK[linked.status] ?? -1;
    if (curRank >= COLUMN_RANK[cfg.deployLine]) {
      return { action: "hold", detail: `#${linked.number} at "${linked.status}" (past deploy line — event/manual owned)` };
    }
    if (wantColumn && linked.status !== wantColumn) {
      return { action: "reconcile", detail: `#${linked.number} "${linked.status || "—"}" -> "${wantColumn}"` };
    }
    return { action: "ok", detail: `#${linked.number} "${linked.status || "—"}"` };
  }

  if (cfg.skipCreateStatus.includes(story.status)) {
    return { action: "skip", detail: `${story.status} (shipped/retired — not backfilled)` };
  }

  if (story.source === "none") {
    // A doc nobody declared a status for is a supporting document in the story dir, not a story. Creating
    // an issue would invent a status and park it on the board as unstarted work forever. Reported loudly.
    return {
      action: "untracked",
      detail: "no status-map entry and no parseable Status: line — NOT a tracked story, no issue created",
    };
  }

  if (!story.hasFile) {
    // The mirror image of `untracked`: the status is real but there is no title or spec to create from.
    return {
      action: "unfiled",
      detail: `no ${story.syncId}.md and no linked issue — no issue created (cures listed below the table)`,
    };
  }

  if (candidate) {
    return {
      action: linkCandidates ? "link" : "review",
      detail: `~ #${candidate.issue.number} "${candidate.issue.title}" (jaccard ${candidate.jac.toFixed(2)})`,
    };
  }
  return { action: "create", detail: `new issue (${wantColumn || "Todo"})` };
}

// ---- fuzzy title match (advisory only; never auto-links unless --link-candidates) ----
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
function bestTitleMatch(storyTitle, issues) {
  const a = new Set(norm(storyTitle));
  let best = null;
  for (const it of issues) {
    const b = new Set(norm(it.title));
    const inter = [...a].filter((w) => b.has(w)).length;
    const jac = inter / (a.size + b.size - inter || 1);
    if (!best || jac > best.jac) best = { issue: it, jac };
  }
  return best && best.jac >= 0.34 ? best : null;
}

// ---- I/O ----------------------------------------------------------------------
let CFG;
let KNOWN_STATUS;
let MARKER;
let MARKER_RE;

// A source's sprint-status file is the CANONICAL machine-readable status source (a clean enum).
// A doc's own `Status:` line is free-form prose, used only as an advisory fallback.
function loadSprintStatus(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const m = line.replace(/#.*/, "").match(/^\s+([\w-]+):\s*([a-z-]+)\s*$/);
    if (m && KNOWN_STATUS.has(m[2])) map.set(m[1], m[2]);
  }
  return map;
}

// A doc's status comes from the COMBINED map (first source wins), wherever the doc itself lives — one
// precedence rule, the same one the conflict report names.
function loadStoryFiles(source, statusMap, groupRe) {
  if (!existsSync(source.storyDir)) {
    console.warn(`  note: story dir ${source.storyDir} does not exist — source "${source.label}" contributes nothing`);
    return [];
  }
  return readdirSync(source.storyDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const path = join(source.storyDir, f);
      const text = readFileSync(path, "utf8");
      const syncId = f.replace(/\.md$/, "");
      const group = (syncId.match(groupRe) || [])[1] || "?";
      const title = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || syncId;
      const prose = (text.match(/^Status:\s*(.+)$/m) || [])[1]?.trim() || "";
      const proseStatus = normalizeProse(prose, KNOWN_STATUS);
      const mapStatus = statusMap.get(syncId) || null;
      const status = mapStatus || proseStatus || "unknown";
      const src = mapStatus ? "map" : proseStatus ? "doc" : "none";
      const drift = mapStatus && proseStatus && mapStatus !== proseStatus ? `${mapStatus}≠${proseStatus}` : null;
      const issue = (text.match(/^Issue:\s*#?(\d+)/m) || [])[1];
      return { syncId, group, title, status, source: src, drift, prose, issue: issue ? Number(issue) : null, path, docLabel: `${source.label}/${f}`, hasFile: true };
    });
}

const findField = (fields, name) => fields.find((f) => f.name === name);
const optionId = (field, name) => field?.options?.find((o) => o.name === name)?.id;

function issueBodies(numbers) {
  const map = new Map();
  for (const n of numbers) {
    try {
      map.set(n, gh(["issue", "view", String(n), "--repo", CFG.repo, "--json", "body", "-q", ".body"]));
    } catch {
      map.set(n, "");
    }
  }
  return map;
}

// ---- main -------------------------------------------------------------------
function main() {
  CFG = loadConfig(["owner", "repo", "projectNumber", "storyDir"]);
  KNOWN_STATUS = new Set(CFG.knownStatus);
  MARKER = (id) => `<!-- ${CFG.markerLabel}: ${id} -->`;
  MARKER_RE = new RegExp(`<!--\\s*${CFG.markerLabel}:\\s*([^\\s]+)\\s*-->`);
  const groupRe = CFG.groupField?.idPattern ? new RegExp(CFG.groupField.idPattern) : /^(\d+)-/;
  const rollupRe = CFG.rollupPattern ? new RegExp(CFG.rollupPattern) : null;
  const args = new Set(process.argv.slice(2));
  const EXECUTE = args.has("--execute");
  const LINK_CANDIDATES = args.has("--link-candidates");

  const sourceMaps = CFG.sources.map((src) => loadSprintStatus(src.sprintStatusFile));
  const { map: sprint, conflicts } = combineStatusMaps(sourceMaps);
  // The same doc in two sources: the first source's copy wins, the duplicate is reported.
  const fileStories = [];
  const dupDocs = [];
  const seenDocs = new Set();
  CFG.sources.forEach((src) => {
    for (const f of loadStoryFiles(src, sprint, groupRe)) {
      if (seenDocs.has(f.syncId)) { dupDocs.push(f.docLabel); continue; }
      seenDocs.add(f.syncId);
      fileStories.push(f);
    }
  });
  const stories = mergeStories(fileStories, sprint, { groupRe, rollupRe });
  const fields = fetchFields(CFG);
  const items = fetchBoardItems(CFG);
  const projectId = fetchProjectId(CFG);

  const projectIssues = items
    .filter((it) => it.content?.type === "Issue")
    .map((it) => ({ itemId: it.id, number: it.content.number, title: it.content.title, status: it.status || null }));
  const bodies = issueBodies(projectIssues.map((i) => i.number));

  const byMarker = new Map();
  for (const pi of projectIssues) {
    const m = (bodies.get(pi.number) || "").match(MARKER_RE);
    if (m) byMarker.set(m[1], pi);
  }
  const byNumber = new Map(projectIssues.map((pi) => [pi.number, pi]));

  const statusField = findField(fields, "Status");
  const groupField = CFG.groupField ? findField(fields, CFG.groupField.name) : null;

  // The board's own column names, checked against the config once, up front — a mismatch otherwise
  // shows only as a column of HOLD rows.
  const boardColumns = new Set((statusField?.options || []).map((o) => o.name));
  const missingColumns = Object.keys(CFG.columnRank).filter((c) => !boardColumns.has(c));

  const plan = [];
  for (const s of stories) {
    let linked = s.issue ? byNumber.get(s.issue) : null;
    if (!linked && byMarker.has(s.syncId)) linked = byMarker.get(s.syncId);
    const wantColumn = CFG.statusToColumn[s.status] || null;
    // A map-only story has no authored title — matching on its slug would fabricate a link. Marker only.
    const candidate = !linked && s.hasFile ? bestTitleMatch(s.title, projectIssues) : null;
    const { action, detail } = decideAction({ story: s, linked, wantColumn, candidate, linkCandidates: LINK_CANDIDATES, cfg: CFG });
    plan.push({ s, linked, wantColumn, candidate: candidate?.issue, action, detail });
  }

  // ---- report ----
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`\ngh-project-sync — "${CFG.projectTitle}" (#${CFG.projectNumber}, ${CFG.owner})`);
  console.log(EXECUTE ? "MODE: EXECUTE (writes enabled)\n" : "MODE: dry-run (no writes) — pass --execute to apply\n");
  console.log(pad("doc", 40), pad("status", 14), pad("src", 6), pad("action", 10), "detail");
  console.log("-".repeat(120));
  const counts = {};
  const drifts = [];
  for (const p of plan) {
    counts[p.action] = (counts[p.action] || 0) + 1;
    if (p.s.drift && p.action !== "skip") drifts.push(`${p.s.syncId} (${p.s.drift})`);
    console.log(pad(p.s.syncId, 40), pad(p.s.status, 14), pad(p.s.source, 6), pad(p.action.toUpperCase(), 10), p.detail);
  }
  console.log("-".repeat(120));
  console.log("summary:", Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  "));
  if (drifts.length) console.log(`drift (map≠doc prose): ${drifts.join(", ")}`);
  if (conflicts.length) {
    console.log(
      `\n⚠️ status maps disagree (${conflicts.length}) — first source wins (${CFG.sources.map((x) => x.label).join(" > ")}): ` +
        conflicts.map((c) => `${c.id} (${c.statuses.join("≠")})`).join(", "),
    );
  }
  if (dupDocs.length) console.log(`\nduplicate docs ignored (an earlier source has the same id): ${dupDocs.join(", ")}`);
  const unfiled = plan.filter((p) => p.action === "unfiled").map((p) => p.s.syncId);
  if (unfiled.length) {
    console.log(`\nunfiled (${unfiled.length}) — in the status map, no doc, no linked issue: ${unfiled.join(", ")}`);
    console.log(
      `  NOT on the board. Write <id>.md in a story dir (${CFG.sources.map((x) => x.storyDir).join(", ")}), or file the issue on "${CFG.projectTitle}" with ` +
        `<!-- ${CFG.markerLabel}: <id> --> in its body.`,
    );
  }
  const untracked = plan.filter((p) => p.action === "untracked").map((p) => p.s.syncId);
  if (untracked.length) {
    console.log(`\nuntracked (${untracked.length}) — docs with no status: ${untracked.join(", ")}`);
    console.log("  If one is really a story, add it to the status map.");
  }
  if (missingColumns.length) {
    console.log(
      `\n⚠️ columnRank names ${missingColumns.map((c) => `"${c}"`).join(", ")} but the board's Status options are ` +
        `${[...boardColumns].map((c) => `"${c}"`).join(", ") || "(none)"}. Fix gh-project-sync.config.json.`,
    );
  }
  if (CFG.groupField && !groupField) console.log(`note: project has no "${CFG.groupField.name}" field yet — --execute will create it.`);

  if (!EXECUTE) {
    console.log("\nDry run complete. Re-run with --execute to apply (creates issues, links, reconciles Status).");
    return;
  }

  // ---- execute ----
  const grp = CFG.groupField ? ensureGroupField(groupField, stories) : null;
  for (const p of plan) {
    if (p.action === "create") doCreate(p, projectId, statusField, grp);
    else if (p.action === "reconcile") setStatus(projectId, p.linked.itemId, statusField, p.wantColumn);
    else if (p.action === "link") doLink(p, p.candidate);
  }
  console.log("\nExecute complete.");
}

// create the grouping single-select field (e.g. "Epic") if missing; return its field object
function ensureGroupField(groupField, stories) {
  let field = groupField;
  const groups = [...new Set(stories.map((s) => s.group))].filter((e) => e !== "?").sort();
  if (!field) {
    const opts = groups.map((e) => `${CFG.groupField.labelPrefix || ""}${e}`).join(",");
    gh(["project", "field-create", String(CFG.projectNumber), "--owner", CFG.owner, "--name", CFG.groupField.name, "--data-type", "SINGLE_SELECT", "--single-select-options", opts]);
    console.log(`created "${CFG.groupField.name}" field with options: ${opts}`);
    field = findField(fetchFields(CFG), CFG.groupField.name);
  }
  return field;
}

function setStatus(projectId, itemId, statusField, columnName) {
  const opt = optionId(statusField, columnName);
  if (!opt) {
    console.warn(`  Status option "${columnName}" not on the board — item ${itemId} left unchanged.`);
    return;
  }
  gh(["project", "item-edit", "--project-id", projectId, "--id", itemId, "--field-id", statusField.id, "--single-select-option-id", opt]);
  console.log(`  set Status="${columnName}" on item ${itemId}`);
}

function setGroup(projectId, itemId, groupField, groupVal) {
  if (!groupField) return;
  const opt = optionId(groupField, `${CFG.groupField.labelPrefix || ""}${groupVal}`);
  if (!opt) return;
  gh(["project", "item-edit", "--project-id", projectId, "--id", itemId, "--field-id", groupField.id, "--single-select-option-id", opt]);
}

// Add a freshly-created issue to the project and return its item id.
// A project with a built-in "auto-add to project" workflow can land the issue on the board before we
// get here; item-add then fails with "Content already exists in this project". That's a race, not an
// error — fall back to resolving the item id the auto-add already created.
function addToProject(url, number) {
  try {
    const added = gh(["project", "item-add", String(CFG.projectNumber), "--owner", CFG.owner, "--url", url, "--format", "json"], { json: true });
    if (added.id) return added.id;
  } catch (err) {
    if (!/already exists in this project/i.test(String(err.stderr || err.message || ""))) throw err;
    console.log(`  note: #${number} was already on the board (project auto-add) — resolving its item id`);
  }
  const found = fetchBoardItems(CFG).find((it) => it.content?.type === "Issue" && it.content.number === number);
  if (!found?.id) throw new Error(`#${number} was neither added to nor found in project ${CFG.projectNumber}`);
  return found.id;
}

function doCreate(p, projectId, statusField, groupField) {
  const s = p.s;
  // decideAction routes a fileless story to `unfiled`; fail loudly if that ever regresses.
  if (!s.hasFile) throw new Error(`refusing to create an issue for ${s.syncId}: no doc to title it from`);
  const body = [
    MARKER(s.syncId),
    "",
    `**Planning doc:** \`${s.docLabel}\``,
    `**${CFG.groupField?.name || "Group"}:** ${s.group}  ·  **Status:** ${s.status}`,
    "",
    "_Spec/content lives in the planning doc; this issue tracks status on the board._",
  ].join("\n");
  const createOut = gh(["issue", "create", "--repo", CFG.repo, "--title", s.title, "--body", body]);
  const m = createOut.match(/https:\/\/github\.com\/\S+\/issues\/(\d+)/);
  if (!m) throw new Error(`could not parse issue URL from: ${createOut}`);
  const url = m[0];
  const number = Number(m[1]);
  console.log(`created #${number} for ${s.syncId} — ${url}`);
  const itemId = addToProject(url, number);
  setStatus(projectId, itemId, statusField, p.wantColumn || "Todo");
  setGroup(projectId, itemId, groupField, s.group);
  writeIssueLine(s, number);
}

function doLink(p, issue) {
  const s = p.s;
  const body = gh(["issue", "view", String(issue.number), "--repo", CFG.repo, "--json", "body", "-q", ".body"]);
  if (!MARKER_RE.test(body)) {
    gh(["issue", "edit", String(issue.number), "--repo", CFG.repo, "--body", `${MARKER(s.syncId)}\n\n${body}`]);
  }
  writeIssueLine(s, issue.number);
  console.log(`linked ${s.syncId} <-> #${issue.number}`);
}

// insert/replace the `Issue: #N` header line in the doc (right after the Status: line)
function writeIssueLine(story, number) {
  if (!story.path || !existsSync(story.path)) {
    console.log(`  note: ${story.syncId} has no doc — #${number} is linked by its ${CFG.markerLabel} marker only`);
    return;
  }
  let text = readFileSync(story.path, "utf8");
  if (/^Issue:\s*#?\d+/m.test(text)) {
    text = text.replace(/^Issue:\s*#?\d+.*$/m, `Issue: #${number}`);
  } else if (/^Status:\s*[^\n]+$/m.test(text)) {
    text = text.replace(/^(Status:\s*[^\n]+)$/m, `$1\nIssue: #${number}`);
  } else {
    // no Status line to anchor to — put it right after the H1
    text = text.replace(/^(#\s+.+)$/m, `$1\nIssue: #${number}`);
  }
  writeFileSync(story.path, text);
}

// Only run when invoked as a script — lets tests import the pure helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
