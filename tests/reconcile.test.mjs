// Story enumeration and action resolution for reconcile.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeStories, decideAction, combineStatusMaps, indexBoardIssues } from "../scripts/reconcile.mjs";
import { withDefaults } from "../scripts/lib.mjs";

const cfg = withDefaults({ owner: "o", repo: "o/r", projectNumber: 6, projectTitle: "2026 H2", storyDir: "stories" });
const rollupRe = new RegExp(cfg.rollupPattern);

const fileStory = (syncId, over = {}) => ({
  syncId,
  group: (syncId.match(/^(\d+)-/) || [])[1] || "?",
  title: `Story ${syncId}`,
  status: "backlog",
  source: "map",
  drift: null,
  prose: "",
  issue: null,
  path: `stories/${syncId}.md`,
  hasFile: true,
  ...over,
});
const mapOnly = (over = {}) => ({ syncId: "12-11-x", status: "backlog", source: "map", hasFile: false, path: null, ...over });
const decide = (args) => decideAction({ cfg, ...args });

describe("mergeStories — the union of doc files and status-map keys", () => {
  it("includes a map entry with NO doc file", () => {
    const merged = mergeStories([], new Map([["12-10-x", "done"]]), { rollupRe });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].hasFile, false);
    assert.equal(merged[0].group, "12");
    assert.equal(merged[0].source, "map");
  });
  it("does not duplicate a story with both, and keeps the file record", () => {
    const merged = mergeStories([fileStory("9-1-x", { title: "Authored", issue: 628 })], new Map([["9-1-x", "review"]]));
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, "Authored");
    assert.equal(merged[0].issue, 628);
  });
  it("still includes a doc with no map entry", () => {
    assert.equal(mergeStories([fileStory("10-8-x", { status: "unknown", source: "none" })], new Map()).length, 1);
  });
  it("sorts numerically so 12-2 precedes 12-10", () => {
    const merged = mergeStories([], new Map([["12-10-b", "backlog"], ["12-2-a", "backlog"]]));
    assert.deepEqual(merged.map((s) => s.syncId), ["12-2-a", "12-10-b"]);
  });
  it("excludes epic roll-ups, but not a slug that merely contains 'epic'", () => {
    const merged = mergeStories([], new Map([["epic-12", "in-progress"], ["12-3-epic-scoped-metrics", "backlog"]]), { rollupRe });
    assert.deepEqual(merged.map((s) => s.syncId), ["12-3-epic-scoped-metrics"]);
  });
});

describe("decideAction — a map-only story is reported, reconciled, never auto-created", () => {
  it("reconciles once linked by its marker", () => {
    const { action, detail } = decide({ story: mapOnly(), linked: { number: 896, status: "In progress" }, wantColumn: "Todo" });
    assert.equal(action, "reconcile");
    assert.match(detail, /#896/);
  });
  it("refuses to create when unlinked, and names the missing doc", () => {
    const { action, detail } = decide({ story: mapOnly(), linked: null, wantColumn: "Todo" });
    assert.equal(action, "unfiled");
    assert.match(detail, /12-11-x\.md/);
    assert.match(detail, /no issue created/);
  });
  it("skip still wins for a done map-only story", () => {
    assert.equal(decide({ story: mapOnly({ status: "done" }), linked: null, wantColumn: null }).action, "skip");
  });
  it("untracked (doc, no status) is a different branch from unfiled (status, no doc)", () => {
    assert.equal(decide({ story: { syncId: "10-8-x", status: "unknown", source: "none", hasFile: true }, linked: null }).action, "untracked");
  });
});

describe("decideAction — file-backed branches", () => {
  it("creates when unlinked with no candidate", () => {
    assert.equal(decide({ story: fileStory("9-2-x"), linked: null, wantColumn: "Todo", candidate: null }).action, "create");
  });
  it("offers a fuzzy candidate as review, links it only under --link-candidates", () => {
    const candidate = { issue: { number: 628, title: "Admin views" }, jac: 0.5 };
    assert.equal(decide({ story: fileStory("9-2-x"), linked: null, wantColumn: "Todo", candidate }).action, "review");
    assert.equal(decide({ story: fileStory("9-2-x"), linked: null, wantColumn: "Todo", candidate, linkCandidates: true }).action, "link");
  });
  it("is ok when already in the wanted column", () => {
    assert.equal(decide({ story: fileStory("9-2-x"), linked: { number: 628, status: "Todo" }, wantColumn: "Todo" }).action, "ok");
  });
});

describe("decideAction — the deploy line is a high-water mark", () => {
  const story = fileStory("7-5-x", { status: "review" });
  it("holds at every column at or past the deploy line", () => {
    for (const status of ["Deployed to Dev", "Ready for prod", "Done"]) {
      const { action, detail } = decide({ story, linked: { number: 1, status }, wantColumn: "In progress" });
      assert.equal(action, "hold");
      assert.match(detail, /past deploy line/);
    }
  });
  it("HOLDS an item in a column it does not recognize (a renamed board) instead of dragging it backward", () => {
    const { action, detail } = decide({ story, linked: { number: 622, status: "Deployed" }, wantColumn: "In progress" });
    assert.equal(action, "hold");
    assert.match(detail, /not recognized/);
  });
  it("still reconciles inside the Todo <-> In progress band", () => {
    assert.equal(decide({ story, linked: { number: 622, status: "Todo" }, wantColumn: "In progress" }).action, "reconcile");
  });
  it("respects a custom columnRank/deployLine", () => {
    const custom = withDefaults({ ...cfg, columnRank: { Backlog: 0, "In Progress": 1, "Deploy to Dev": 2, Done: 3 }, deployLine: "Deploy to Dev" });
    assert.equal(decideAction({ cfg: custom, story, linked: { number: 1, status: "Deploy to Dev" }, wantColumn: "In Progress" }).action, "hold");
    assert.equal(decideAction({ cfg: custom, story, linked: { number: 1, status: "Backlog" }, wantColumn: "In Progress" }).action, "reconcile");
  });
});

describe("combineStatusMaps — several story trees, one board", () => {
  it("unions the maps, first source winning", () => {
    const { map } = combineStatusMaps([new Map([["1-1-a", "done"]]), new Map([["1-1-a", "review"], ["2-1-b", "backlog"]])]);
    assert.equal(map.get("1-1-a"), "done");
    assert.equal(map.get("2-1-b"), "backlog");
  });
  it("reports every id the sources disagree on, and only those", () => {
    const { conflicts } = combineStatusMaps([
      new Map([["5-13-x", "done"], ["7-4-y", "superseded"], ["3-1-z", "done"]]),
      new Map([["5-13-x", "review"], ["7-4-y", "backlog"], ["3-1-z", "done"]]),
    ]);
    assert.deepEqual(conflicts, [
      { id: "5-13-x", statuses: ["done", "review"] },
      { id: "7-4-y", statuses: ["superseded", "backlog"] },
    ]);
  });
});

describe("indexBoardIssues — a board shared by several repos", () => {
  const items = [
    { id: "I1", status: "In Progress", content: { type: "Issue", number: 183, repository: "o/app", title: "Transcoding", body: "<!-- sync-id: 12-3-x -->" } },
    { id: "I2", status: "Done", content: { type: "Issue", number: 183, repository: "o/api", title: "Log encryption", body: "" } },
    { id: "I3", status: "Todo", content: { type: "DraftIssue", title: "draft" } },
  ];
  it("joins `Issue: #N` only to the home repo's #N, never a colliding number elsewhere", () => {
    const { byNumber, projectIssues } = indexBoardIssues(items, "o/app");
    assert.equal(byNumber.get(183).itemId, "I1");
    assert.equal(projectIssues.length, 2);
  });
  it("labels foreign-repo issues with their repo", () => {
    const { projectIssues } = indexBoardIssues(items, "o/app");
    assert.deepEqual(projectIssues.map((p) => p.label), ["#183", "o/api#183"]);
  });
  it("names a foreign-repo link by its repo in the report", () => {
    const linked = indexBoardIssues(items, "o/app").projectIssues[1];
    assert.match(decide({ story: fileStory("23-9-x"), linked, wantColumn: "Todo" }).detail, /o\/api#183/);
  });
});
