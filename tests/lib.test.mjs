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
