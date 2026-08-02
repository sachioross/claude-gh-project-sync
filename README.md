# gh-project-sync

A Claude Code plugin that keeps **markdown planning/story docs** and a **GitHub Project (v2) board** in
a consistent, idempotent, auto-managed state — joined by a stable id, dry-run-first, forward-only past a
configurable "deploy line."

Generalized from a BMAD ↔ GitHub Project sync. It stays **BMAD-shaped** (a story dir + optional
`sprint-status.yaml`) but every repo-specific value — owner, repo, project number, doc dir, status enum,
column mapping, grouping field — is set in a per-repo `gh-project-sync.config.json`.

## The three legs

1. **Reconciler** (`scripts/reconcile.mjs`) — dry-run by default. Joins docs ↔ Project items by a
   `<!-- sync-id: … -->` marker (mirrored as an `Issue: #N` line in the doc), creates/links issues, and
   reconciles the **Todo ↔ In progress** band from each doc's status. `--execute` to write.
2. **Advancer** (`scripts/advance.mjs`) — event-driven. Fired by a GitHub Action on deploy success;
   resolves which issues a merged PR references and advances them **forward only** to the deploy line.
3. **The skill** (`skills/gh-project-sync/SKILL.md`) — the entry point + mental model (dual
   source-of-truth, ownership zones, the deploy-line high-water mark).

## Core idea: two sources of truth, one bridge

- **Spec/content** lives in the doc (rich, versioned, agent-edited).
- **Tracking/status** lives in the Project item (visible, PR-linked, drives the board).
- A **stable `sync-id`** stored in both keeps them joined across renames and re-runs.
- The **deploy line** splits ownership: the reconciler owns Todo ↔ In progress; deploy events and humans
  own everything past it. The reconciler never drags an item backward across that line.

## Install

**As a plugin (recommended):** add this repo as a marketplace, then install:

```
/plugin marketplace add sachioross/claude-gh-project-sync
/plugin install gh-project-sync@sachio-tooling
```

(a local path — `/plugin marketplace add /path/to/claude-gh-project-sync` — also works for a checkout.)

**Or vendor the scripts:** copy `scripts/*.mjs` into a target repo (e.g. `scripts/gh-project-sync/`) and
run them directly.

## Per-repo setup

1. Copy `templates/gh-project-sync.config.json` → repo root, edit `owner` / `repo` / `projectNumber` /
   `storyDir` (rest defaults to BMAD-shaped values).
2. `gh auth refresh -s project,read:project`.
3. Dry-run: `node <plugin>/scripts/reconcile.mjs` → review → `--execute`.
4. (Optional) copy `templates/project-sync.yml` → `.github/workflows/`, set the deploy-workflow name +
   integration branch, and add a `PROJECTS_TOKEN` secret (project scope) for the auto-advance.

See `skills/gh-project-sync/SKILL.md` for the full run guide.

## Provision to a team

To hand this plugin to everyone who opens a *different* project repo — without each teammate running
`/plugin marketplace add` — commit this into that repo's **`.claude/settings.json`** (the shared,
checked-in settings file, not `settings.local.json`):

```json
{
  "extraKnownMarketplaces": {
    "sachio-tooling": {
      "source": { "source": "github", "repo": "sachioross/claude-gh-project-sync" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "gh-project-sync@sachio-tooling": true
  }
}
```

- `extraKnownMarketplaces` is keyed by the **marketplace** name (from `marketplace.json`); its value is an
  object with a nested `source` (`github` + `repo` shorthand shown; `url` / `git-subdir` / `npm` also work).
- `enabledPlugins` is keyed by the exact `"plugin@marketplace"` string, mapped to a boolean.
- On first trusting the repo folder, Claude Code **prompts** the teammate to install the marketplace; once
  accepted, the enabled plugin auto-installs — no further command. A teammate opts out with
  `"gh-project-sync@sachio-tooling": false` in their own `.claude/settings.local.json`.
- Requires **Claude Code v2.1.195+** (the auto-prompt-on-trust behavior); older builds silently no-op and
  need a manual `/plugin marketplace add`.

## Config reference

Only `owner`, `repo`, `projectNumber`, `storyDir` are required. Notable optional keys:

| Key | Default | Meaning |
|---|---|---|
| `sprintStatusFile` | none | Canonical status map (BMAD `sprint-status.yaml`); else the doc's `Status:` prose is used |
| `markerLabel` | `sync-id` | The HTML-comment marker key stored in issue bodies |
| `statusToColumn` | BMAD map | Which doc status maps to which reconciler-managed column |
| `columnRank` / `deployLine` | Todo…Done / "Deployed to Dev" | Column order + the high-water-mark boundary |
| `skipCreateStatus` | `done`, `superseded` | Statuses that never get a forward-board issue |
| `groupField` | `Epic` (from `^(\d+)-`) | Optional single-select grouping field derived from the id prefix |

## Requirements

- `gh` CLI, authed with `project` scope.
- Node 18+ (scripts are dependency-free ESM).
- A GitHub Project (v2) with a **Status** single-select field whose option names match `columnRank`.
