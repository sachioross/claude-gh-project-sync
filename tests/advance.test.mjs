// Tracking-reference parsing + the planning-only file guard for advance.mjs.
// Fixtures are real PR text from the upstream repo this plugin was generalized from; each one either
// advanced the wrong issue under an earlier rule or pins the rule that fixed it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advancingIssues, referenceOnlyIssues, stripCodeSpans, isPlanningOnlyPr, pullFilePaths } from "../scripts/advance.mjs";

describe("advancingIssues — a claim that the PR SHIPS the issue", () => {
  it("reads Addresses, including a list under one keyword", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "Addresses #623" }), [623]);
    assert.deepEqual(advancingIssues({ title: "", body: "Addresses #644, #645" }), [644, 645]);
  });
  it("reads an advancing ref inline in a heading (not just a trailer line)", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "## Story 9.3 — Invoice combination (Addresses #629)" }), [629]);
  });
  it("accepts the GitHub closers and the address variants", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "Closes #12\nFixes #13\nResolves #14" }), [12, 13, 14]);
    assert.deepEqual(advancingIssues({ title: "", body: "Address #1\nAddresses #2\nAddressed #3" }), [1, 2, 3]);
  });
  it("tolerates a colon and irregular spacing", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "Addresses: #700\nCloses:#701" }), [700, 701]);
  });
  it("handles missing title/body", () => {
    assert.deepEqual(advancingIssues({}), []);
    assert.deepEqual(referenceOnlyIssues({}), []);
  });
});

describe("a plain reference is NOT a claim that it shipped", () => {
  it("does not advance on Refs / See / Related to / References", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "Refs #623\nSee #10\nRelated to #11\nReferences #12" }), []);
  });
  it("advances only the claimed issue when a PR does both", () => {
    const pr = { title: "", body: "Addresses #862\nRefs #858" };
    assert.deepEqual(advancingIssues(pr), [862]);
    assert.deepEqual(referenceOnlyIssues(pr), [858]);
  });
  it("lets the stronger claim win when one issue is named both ways", () => {
    const pr = { title: "", body: "Refs #5\nCloses #5" };
    assert.deepEqual(advancingIssues(pr), [5]);
    assert.deepEqual(referenceOnlyIssues(pr), []);
  });
  it("replays a story-drafting PR that once advanced five backlog issues", () => {
    const pr = { title: "docs: consolidate three story drafts", body: "Refs #681, #684, #645, #677, #678" };
    assert.deepEqual(advancingIssues(pr), []);
    assert.deepEqual(referenceOnlyIssues(pr), [681, 684, 645, 677, 678]);
  });
});

describe("ignores everything that is not a tracking ref", () => {
  it("ignores bare numbers in prose and headings", () => {
    const body = "Follow-ups from Story 9.7 (#633, merged in #643).\n## 8.16 (#644, ready-for-dev)\n\nAddresses #645";
    assert.deepEqual(advancingIssues({ title: "", body }), [645]);
  });
  it("ignores a project number in a title", () => {
    assert.deepEqual(advancingIssues({ title: 'feat: auto-sync stories with GitHub Project (#6)', body: "" }), []);
  });
  it("does not treat a keyword-prefixed word as a keyword", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "Fixing #640 meant editing a string literal." }), []);
  });
  it("ignores an issue discussed in a section heading", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "## Note on #640\n\nprose\n\nAddresses #634" }), [634]);
  });
});

describe("stripCodeSpans — documenting the convention must not trigger it", () => {
  it("ignores trailers in inline spans, fenced blocks and double-backtick spans", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "an `Addresses #863` line here would advance it" }), []);
    assert.deepEqual(advancingIssues({ title: "", body: "like this:\n\n```\nAddresses #863\n```\n" }), []);
    assert.deepEqual(advancingIssues({ title: "", body: "Use `` `Addresses #863` `` in the body." }), []);
  });
  it("still reads a real trailer alongside a quoted example", () => {
    assert.deepEqual(advancingIssues({ title: "", body: "Do not write `Refs #999`.\n\nAddresses #863" }), [863]);
  });
  it("strips spans without swallowing surrounding text", () => {
    assert.equal(stripCodeSpans("a `b` c"), "a   c");
    assert.equal(stripCodeSpans("x ```\nfenced\n``` y"), "x   y");
    assert.equal(stripCodeSpans(null), "");
  });
});

describe("isPlanningOnlyPr — a PR that ships no code cannot be deployed", () => {
  it("treats story-drafting and docs-only PRs as planning-only (default prefixes)", () => {
    assert.equal(isPlanningOnlyPr(["_bmad-output/implementation-artifacts/9-13-x.md", "_bmad-output/implementation-artifacts/sprint-status.yaml"]), true);
    assert.equal(isPlanningOnlyPr(["docs/runbook.md", "_bmad-output/implementation-artifacts/10-9-x.md"]), true);
  });
  it("does NOT skip a PR that touches planning AND code", () => {
    assert.equal(isPlanningOnlyPr(["_bmad-output/implementation-artifacts/10-2-x.md", "app/routes/admin.users.tsx"]), false);
    assert.equal(isPlanningOnlyPr(["docs/runbook.md", "prisma/migrations/x/migration.sql"]), false);
  });
  it("is not fooled by a path that merely contains a prefix", () => {
    assert.equal(isPlanningOnlyPr(["app/routes/docs/thing.tsx"]), false);
    assert.equal(isPlanningOnlyPr(["app/models/_bmad-output/thing.ts"]), false);
  });
  it("honours configured prefixes, one directory at a time", () => {
    const prefixes = ["_bmad-output/", "docs/", "scripts/fact-flow/"];
    assert.equal(isPlanningOnlyPr(["scripts/fact-flow/trace.mjs"], prefixes), true);
    assert.equal(isPlanningOnlyPr(["scripts/db-connect.sh"], prefixes), false);
    assert.equal(isPlanningOnlyPr(["scripts/fact-flow-runner.mjs"], prefixes), false);
  });
  it("fails OPEN when the file list is unavailable or empty", () => {
    assert.equal(isPlanningOnlyPr(null), false);
    assert.equal(isPlanningOnlyPr(undefined), false);
    assert.equal(isPlanningOnlyPr([]), false);
  });
});

describe("pullFilePaths — reads `filename` from the real pulls/files payload", () => {
  const page = [
    { sha: "937bcc7", filename: "_bmad-output/implementation-artifacts/9-13-x.md", status: "modified" },
    { sha: "aa11bb2", filename: "_bmad-output/implementation-artifacts/sprint-status.yaml", status: "modified" },
  ];
  it("extracts and flattens pages", () => {
    assert.deepEqual(pullFilePaths([page]), page.map((f) => f.filename));
    assert.equal(pullFilePaths([page, [{ filename: "app/x.tsx" }]]).length, 3);
  });
  it("never invents a path from an object without `filename`", () => {
    assert.deepEqual(pullFilePaths([[{ path: "app/x.ts" }, { sha: "x" }]]), []);
  });
  it("returns null for a non-array payload, and composes with the guard", () => {
    assert.equal(pullFilePaths(null), null);
    assert.equal(isPlanningOnlyPr(pullFilePaths([page])), true);
  });
});
