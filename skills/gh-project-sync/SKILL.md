---
name: gh-project-sync
description: 'Reconcile markdown planning/story docs with a GitHub Project (v2) board — create/link issues, push Status, join by a stable id. Use when the user says "sync the backlog", "sync stories to github", "push this story to the project", or "reconcile stories and issues".'
---

# Docs ↔ GitHub Project Sync

Keeps local markdown planning docs and a GitHub Project (v2) board in a consistent, auto-managed,
idempotent state. Config-driven; BMAD-shaped by default (a story dir + optional `sprint-status.yaml`),
but the doc dir, id-derivation, status enum, and column mapping are all set in a per-repo config file.

## The model (why this is safe to run repeatedly)

- **Spec/content source of truth = the planning doc** (rich, versioned, agent-edited).
- **Tracking/status source of truth = the GitHub Project item.**
- **Bridge = a stable `sync-id`** (by default the doc's filename stem), stored in BOTH: an `Issue: #NNN`
  header line in the doc, and a `<!-- sync-id: … -->` marker in the issue body. The join survives
  renames and re-runs.
- **Status source of truth =** the optional `sprintStatusFile` map if configured, else the doc's own
  `Status:` prose line (normalized to the enum as a fallback). **Keep the status map current** — the
  sync is only as accurate as it is.

### Status → column mapping (ownership zones)

The `deployLine` (default **"Deployed to Dev"**) splits the board into two zones:

| Zone | Columns | Owned by |
|---|---|---|
| Reconciler band | **Todo ↔ In progress** | `reconcile.mjs` (this skill), driven by the doc's status |
| Past the deploy line | **Deployed to Dev** | `advance.mjs`, on a deploy event (GitHub Action) |
| | **Ready for prod / Done** | you, manually (a deliberate release signal) |

**The deploy line is a high-water mark.** The reconciler only manages Todo ↔ In progress; once an item
is at/after the deploy line it is left alone, even if the doc still says `review`. It never moves an
item backward across that line.

## Setup (once per repo)

1. Copy `templates/gh-project-sync.config.json` to the repo root and edit `owner`, `repo`,
   `projectNumber`, `storyDir` (the rest defaults to BMAD-shaped values).
2. Ensure `gh` is authed with project scope: `gh auth refresh -s project,read:project`.
3. (Optional, for the deploy-line auto-advance) copy `templates/project-sync.yml` into
   `.github/workflows/`, fill in the deploy-workflow name + integration branch, and add a
   `PROJECTS_TOKEN` secret (a token with `project` scope — the default `GITHUB_TOKEN` can't write org
   Projects v2).

## How to run

Run from the target repo root. `<plugin>` = this plugin's root (`${CLAUDE_PLUGIN_ROOT}`).

1. **Dry run first (no writes)** — always review the mapping report before applying:
   ```
   node <plugin>/scripts/reconcile.mjs
   ```
   Read the report: `CREATE` = new issue, `RECONCILE` = Status change, `OK` = already in sync,
   `SKIP` = shipped/retired, `REVIEW` = a fuzzy title match to an existing issue (not auto-linked),
   `HOLD` = past the deploy line. Note any `drift (map≠doc prose)` — that flags a status entry to fix.

2. **Apply**:
   ```
   node <plugin>/scripts/reconcile.mjs --execute
   ```
   Creates issues (title = doc H1, body links the doc + carries the marker), adds them to the project,
   sets the **Status** (and optional grouping field, e.g. **Epic**), and writes `Issue: #NNN` back into
   each doc. Idempotent and resumable — re-running only touches what changed.

   Add `--link-candidates` to also auto-link the fuzzy `REVIEW` matches to existing issues.

Tip: wire these as `npm` scripts in the target repo (`"sync": "node .../reconcile.mjs"`,
`"sync:apply": "node .../reconcile.mjs --execute"`) for a shorter invocation.

## When creating a NEW doc that should land on the board

Add its `sync-id` (filename stem) to the status map with the right status, then run the apply command —
the doc gets an issue, is placed on the board, and the issue number is written back into it. Going the
other way (an existing project issue → a new doc), scaffold the doc, then the next sync links them by id
(or by fuzzy title with `--link-candidates`).

## Mechanics

- `scripts/reconcile.mjs` — the reconciler (Todo ↔ In progress band). Dependency-free; shells out to `gh`.
- `scripts/advance.mjs` — the event-driven advancer (→ deploy line), invoked by the GitHub Action.
- All BMAD/repo-specific values live in `gh-project-sync.config.json` in the target repo.
