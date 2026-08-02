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
//     once past it, that item is a high-water mark this script leaves alone.
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

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// ---- config -----------------------------------------------------------------
function loadConfig() {
  const path = process.env.GH_PROJECT_SYNC_CONFIG || "gh-project-sync.config.json";
  const abs = isAbsolute(path) ? path : join(process.cwd(), path);
  if (!existsSync(abs)) {
    console.error(`gh-project-sync: config not found at ${abs}`);
    console.error("Create one from the plugin's templates/gh-project-sync.config.json (or set GH_PROJECT_SYNC_CONFIG).");
    process.exit(1);
  }
  const c = JSON.parse(readFileSync(abs, "utf8"));
  // sensible BMAD-shaped defaults for anything omitted
  c.markerLabel = c.markerLabel || "sync-id";
  c.knownStatus = c.knownStatus || ["backlog", "ready-for-dev", "in-progress", "review", "done", "superseded", "blocked"];
  c.statusToColumn = c.statusToColumn || { backlog: "Todo", "ready-for-dev": "Todo", "in-progress": "In progress", review: "In progress" };
  c.columnRank = c.columnRank || { Todo: 0, "In progress": 1, "Deployed to Dev": 2, "Ready for prod": 3, Done: 4 };
  c.deployLine = c.deployLine || "Deployed to Dev";
  c.skipCreateStatus = c.skipCreateStatus || ["done", "superseded"];
  c.groupField = c.groupField || null; // e.g. { name: "Epic", labelPrefix: "Epic ", idPattern: "^(\\d+)-" }
  for (const k of ["owner", "repo", "projectNumber", "storyDir"]) {
    if (c[k] === undefined) { console.error(`gh-project-sync: config is missing required key "${k}"`); process.exit(1); }
  }
  c.sprintStatusFile = c.sprintStatusFile || null; // optional canonical status map (BMAD sprint-status.yaml)
  c.projectTitle = c.projectTitle || `#${c.projectNumber}`;
  return c;
}

const CFG = loadConfig();
const KNOWN_STATUS = new Set(CFG.knownStatus);
const STATUS_TO_COLUMN = CFG.statusToColumn;
const COLUMN_RANK = CFG.columnRank;
const DEPLOY_LINE = COLUMN_RANK[CFG.deployLine];
const SKIP_CREATE_STATUS = new Set(CFG.skipCreateStatus);
const GROUP_ID_RE = CFG.groupField?.idPattern ? new RegExp(CFG.groupField.idPattern) : /^(\d+)-/;

const ARGS = new Set(process.argv.slice(2));
const EXECUTE = ARGS.has("--execute");
const LINK_CANDIDATES = ARGS.has("--link-candidates");

const MARKER = (id) => `<!-- ${CFG.markerLabel}: ${id} -->`;
const MARKER_RE = new RegExp(`<!--\\s*${CFG.markerLabel}:\\s*([^\\s]+)\\s*-->`);

// ---- shell helpers ----------------------------------------------------------
function gh(args, { json = false } = {}) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return json ? JSON.parse(out) : out.trim();
}

// The optional sprint-status file is the CANONICAL machine-readable status source (a clean enum).
// A doc's own `Status:` line is free-form prose, used only as an advisory fallback.
function loadSprintStatus() {
  const map = new Map();
  if (!CFG.sprintStatusFile || !existsSync(CFG.sprintStatusFile)) return map;
  const text = readFileSync(CFG.sprintStatusFile, "utf8");
  for (const line of text.split("\n")) {
    const m = line.replace(/#.*/, "").match(/^\s+([\w-]+):\s*([a-z-]+)\s*$/);
    if (m && KNOWN_STATUS.has(m[2])) map.set(m[1], m[2]);
  }
  return map;
}

// best-effort enum from a free-form `Status:` prose line (fallback only)
function normalizeProse(prose) {
  if (!prose) return null;
  const lead = prose.replace(/^[*_\s]+/, "").match(/^([a-z][a-z-]+)/i);
  if (lead && KNOWN_STATUS.has(lead[1].toLowerCase())) return lead[1].toLowerCase();
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

// ---- read planning docs -----------------------------------------------------
function loadStories() {
  const sprint = loadSprintStatus();
  return readdirSync(CFG.storyDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const path = join(CFG.storyDir, f);
      const text = readFileSync(path, "utf8");
      const syncId = f.replace(/\.md$/, "");
      const group = (syncId.match(GROUP_ID_RE) || [])[1] || "?";
      const title = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || syncId;
      const prose = (text.match(/^Status:\s*(.+)$/m) || [])[1]?.trim() || "";
      const proseStatus = normalizeProse(prose);
      const yamlStatus = sprint.get(syncId) || null;
      const status = yamlStatus || proseStatus || "unknown";
      const source = yamlStatus ? "map" : proseStatus ? "doc" : "none";
      const drift = yamlStatus && proseStatus && yamlStatus !== proseStatus ? `${yamlStatus}≠${proseStatus}` : null;
      const issue = (text.match(/^Issue:\s*#?(\d+)/m) || [])[1];
      return { syncId, group, title, status, source, drift, prose, issue: issue ? Number(issue) : null, path, text };
    })
    .sort((a, b) => a.syncId.localeCompare(b.syncId, undefined, { numeric: true }));
}

// ---- read the project -------------------------------------------------------
function loadProject() {
  const fields = gh(["project", "field-list", String(CFG.projectNumber), "--owner", CFG.owner, "--format", "json", "-L", "50"], { json: true }).fields;
  const items = gh(["project", "item-list", String(CFG.projectNumber), "--owner", CFG.owner, "--format", "json", "-L", "500"], { json: true }).items;
  const projectId = gh(["project", "view", String(CFG.projectNumber), "--owner", CFG.owner, "--format", "json"], { json: true }).id;
  return { fields, items, projectId };
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

// ---- main -------------------------------------------------------------------
function main() {
  const stories = loadStories();
  const { fields, items, projectId } = loadProject();

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

  const plan = [];
  for (const s of stories) {
    let linked = s.issue ? byNumber.get(s.issue) : null;
    if (!linked && byMarker.has(s.syncId)) linked = byMarker.get(s.syncId);

    const wantColumn = STATUS_TO_COLUMN[s.status] || null;

    let action, detail;
    if (linked) {
      const curRank = COLUMN_RANK[linked.status] ?? -1;
      if (curRank >= DEPLOY_LINE) {
        action = "hold"; detail = `#${linked.number} at "${linked.status}" (past deploy line — event/manual owned)`;
      } else if (wantColumn && linked.status !== wantColumn) {
        action = "reconcile"; detail = `#${linked.number} "${linked.status || "—"}" -> "${wantColumn}"`;
      } else {
        action = "ok"; detail = `#${linked.number} "${linked.status || "—"}"`;
      }
    } else if (SKIP_CREATE_STATUS.has(s.status)) {
      action = "skip"; detail = `${s.status} (shipped/retired — not backfilled)`;
    } else {
      const cand = bestTitleMatch(s.title, projectIssues);
      if (cand) {
        action = LINK_CANDIDATES ? "link" : "review";
        detail = `~ #${cand.issue.number} "${cand.issue.title}" (jaccard ${cand.jac.toFixed(2)})`;
        s._candidate = cand.issue;
      } else {
        action = "create"; detail = `new issue (${wantColumn || "Todo"})`;
      }
    }
    plan.push({ s, linked, wantColumn, action, detail });
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
  if (CFG.groupField && !groupField) console.log(`note: project has no "${CFG.groupField.name}" field yet — --execute will create it.`);

  if (!EXECUTE) {
    console.log("\nDry run complete. Re-run with --execute to apply (creates issues, links, reconciles Status).");
    return;
  }

  // ---- execute ----
  const grp = CFG.groupField ? ensureGroupField(fields, groupField, stories) : null;
  for (const p of plan) {
    if (p.action === "create") doCreate(p, projectId, statusField, grp);
    else if (p.action === "reconcile") setStatus(projectId, p.linked.itemId, statusField, p.wantColumn);
    else if (p.action === "link") doLink(p, p.s._candidate);
  }
  console.log("\nExecute complete.");
}

// create the grouping single-select field (e.g. "Epic") if missing; return its field object
function ensureGroupField(fields, groupField, stories) {
  let field = groupField;
  const groups = [...new Set(stories.map((s) => s.group))].filter((e) => e !== "?").sort();
  if (!field) {
    const opts = groups.map((e) => `${CFG.groupField.labelPrefix || ""}${e}`).join(",");
    gh(["project", "field-create", String(CFG.projectNumber), "--owner", CFG.owner, "--name", CFG.groupField.name, "--data-type", "SINGLE_SELECT", "--single-select-options", opts]);
    console.log(`created "${CFG.groupField.name}" field with options: ${opts}`);
    const refreshed = gh(["project", "field-list", String(CFG.projectNumber), "--owner", CFG.owner, "--format", "json", "-L", "50"], { json: true }).fields;
    field = findField(refreshed, CFG.groupField.name);
  }
  return field;
}

function setStatus(projectId, itemId, statusField, columnName) {
  const opt = optionId(statusField, columnName);
  if (!opt) return;
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
  const items = gh(["project", "item-list", String(CFG.projectNumber), "--owner", CFG.owner, "--format", "json", "-L", "500"], { json: true }).items;
  const found = items.find((it) => it.content?.type === "Issue" && it.content.number === number);
  if (!found?.id) throw new Error(`#${number} was neither added to nor found in project ${CFG.projectNumber}`);
  return found.id;
}

function doCreate(p, projectId, statusField, groupField) {
  const s = p.s;
  const body = [
    MARKER(s.syncId),
    "",
    `**Planning doc:** \`${CFG.storyDir}/${s.syncId}.md\``,
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

main();
