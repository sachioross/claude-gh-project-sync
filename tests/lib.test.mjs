import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBoardFetch, withDefaults, DEFAULTS } from "../scripts/lib.mjs";

describe("checkBoardFetch — a full page is a loud failure, not a permissions mystery", () => {
  it("passes a page with room, refuses a full one or a missing list", () => {
    assert.equal(checkBoardFetch(new Array(203).fill({}), 2000), null);
    assert.match(checkBoardFetch(new Array(200).fill({}), 200), /fetch limit \(200\)/);
    assert.match(checkBoardFetch(undefined, 200), /no item list/);
  });
  it("defaults to a limit with headroom", () => {
    assert.ok(DEFAULTS.boardFetchLimit >= 1000);
  });
});

describe("withDefaults", () => {
  it("fills omitted keys and keeps overrides", () => {
    const c = withDefaults({ projectNumber: 2, boardFetchLimit: 50 });
    assert.equal(c.boardFetchLimit, 50);
    assert.equal(c.markerLabel, "sync-id");
    assert.equal(c.projectTitle, "#2");
  });
});

describe("withDefaults — sources", () => {
  it("wraps a single storyDir as one source labelled by its dir", () => {
    const c = withDefaults({ storyDir: "stories", sprintStatusFile: "stories/s.yaml" });
    assert.deepEqual(c.sources, [{ label: "stories", storyDir: "stories", sprintStatusFile: "stories/s.yaml" }]);
  });
  it("takes explicit sources as given", () => {
    const c = withDefaults({ sources: [{ label: "app", storyDir: "a" }, { label: "api", storyDir: "../api/a", sprintStatusFile: "../api/s.yaml" }] });
    assert.equal(c.sources.length, 2);
    assert.equal(c.sources[0].sprintStatusFile, null);
    assert.equal(c.sources[1].label, "api");
  });
});
