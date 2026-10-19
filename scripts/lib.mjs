// gh-project-sync / lib — config, the `gh` shell-out, and the board fetch shared by reconcile.mjs and
// advance.mjs. Kept in ONE place on purpose: the original per-repo scripts carried COLUMN_RANK and the
// board fetch limit as copies in two files, and a board rename or growth past the limit broke them one at
// a time, silently.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export const DEFAULTS = {
  markerLabel: "sync-id",
  knownStatus: ["backlog", "ready-for-dev", "in-progress", "review", "done", "superseded", "blocked"],
  statusToColumn: { backlog: "Todo", "ready-for-dev": "Todo", "in-progress": "In progress", review: "In progress" },
  columnRank: { Todo: 0, "In progress": 1, "Deployed to Dev": 2, "Ready for prod": 3, Done: 4 },
  deployLine: "Deployed to Dev",
  skipCreateStatus: ["done", "superseded"],
  groupField: null, // e.g. { name: "Epic", labelPrefix: "Epic ", idPattern: "^(\\d+)-" }
  sprintStatusFile: null,
  // `development_status:` keys that summarise their children (BMAD `epic-7: in-progress`). Never a work item.
  rollupPattern: "^epic-\\d+$",
  // A merged PR whose files ALL sit under these prefixes ships nothing testable and never advances the board.
  planningOnlyPrefixes: ["_bmad-output/", "docs/"],
  boardFetchLimit: 2000,
};

// Applies DEFAULTS. Pure, so tests can build a config without a file on disk.
export function withDefaults(raw) {
  const c = { ...DEFAULTS, ...raw };
  c.projectTitle = c.projectTitle || `#${c.projectNumber}`;
  // `sources` lets one board span several story trees (e.g. an app repo and an api repo that each keep
  // their own BMAD output). Without it, the single storyDir/sprintStatusFile pair is the only source.
  c.sources = (c.sources || (c.storyDir ? [{ storyDir: c.storyDir, sprintStatusFile: c.sprintStatusFile }] : [])).map((src) => ({
    label: src.label || src.storyDir,
    storyDir: src.storyDir,
    sprintStatusFile: src.sprintStatusFile || null,
  }));
  return c;
}

export function loadConfig(required) {
  const path = process.env.GH_PROJECT_SYNC_CONFIG || "gh-project-sync.config.json";
  const abs = isAbsolute(path) ? path : join(process.cwd(), path);
  if (!existsSync(abs)) {
    console.error(`gh-project-sync: config not found at ${abs}`);
    console.error("Create one from the plugin's templates/gh-project-sync.config.json (or set GH_PROJECT_SYNC_CONFIG).");
    process.exit(1);
  }
  const c = withDefaults(JSON.parse(readFileSync(abs, "utf8")));
  for (const k of required) {
    const missing = k === "storyDir" ? !c.sources.length : c[k] === undefined;
    if (missing) { console.error(`gh-project-sync: config is missing required key "${k === "storyDir" ? "storyDir (or sources)" : k}"`); process.exit(1); }
  }
  return c;
}

// `token` overrides the credential for one call. advance.mjs needs two: the project token cannot
// necessarily read a private repo, and GitHub answers 404 (not 403) when it cannot.
export function gh(args, { json = false, allowFail = false, token = null } = {}) {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env,
    });
    return json ? JSON.parse(out) : out.trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// `gh project item-list` returns one page. A board that grows past the page silently drops its NEWEST
// issues (observed upstream at 203 items against a 200 limit: they read as "not on the board"). A full
// page is therefore an error, not a result.
export function checkBoardFetch(items, limit = DEFAULTS.boardFetchLimit) {
  if (!Array.isArray(items)) return `board fetch returned no item list (limit ${limit}).`;
  if (items.length >= limit) {
    return (
      `board fetch returned ${items.length} items, which is the fetch limit (${limit}) — the board may have ` +
      `outgrown the page and the newest issues would be silently skipped. Raise "boardFetchLimit" in ` +
      `gh-project-sync.config.json.`
    );
  }
  return null;
}

export function fetchBoardItems(cfg) {
  const limit = cfg.boardFetchLimit;
  const items = gh(["project", "item-list", String(cfg.projectNumber), "--owner", cfg.owner, "--format", "json", "-L", String(limit)], { json: true }).items;
  const overflow = checkBoardFetch(items, limit);
  if (overflow) { console.error(overflow); process.exit(1); }
  return items;
}

export function fetchFields(cfg) {
  return gh(["project", "field-list", String(cfg.projectNumber), "--owner", cfg.owner, "--format", "json", "-L", "50"], { json: true }).fields;
}

export function fetchProjectId(cfg) {
  return gh(["project", "view", String(cfg.projectNumber), "--owner", cfg.owner, "--format", "json"], { json: true }).id;
}
