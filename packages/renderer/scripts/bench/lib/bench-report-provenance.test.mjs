// #46 report provenance validation tests: cross-document mixing rules.
import { describe, expect, it } from "vitest";
import { crossDocumentProvenanceProblem } from "./provenance.mjs";

function doc(overrides = {}) {
  return {
    schemaVersion: 1,
    commit: "aaaa1111",
    workingTreeDirty: false,
    environment: {},
    cases: [],
    ...overrides,
  };
}

describe("crossDocumentProvenanceProblem", () => {
  it("accepts same-commit clean documents (GPU/CPU/DOM)", () => {
    const problem = crossDocumentProvenanceProblem([doc(), doc(), doc()]);
    expect(problem).toBeNull();
  });
  it("rejects a document from a different commit", () => {
    const problem = crossDocumentProvenanceProblem([doc(), doc({ commit: "bbbb2222" })]);
    expect(problem).toContain("commit mismatch");
  });
  it("rejects a dirty-tree document", () => {
    const problem = crossDocumentProvenanceProblem([doc(), doc({ workingTreeDirty: true })]);
    expect(problem).toContain("DIRTY working tree");
  });
  it("rejects a schemaVersion mismatch", () => {
    const problem = crossDocumentProvenanceProblem([doc(), doc({ schemaVersion: 2 })]);
    expect(problem).toContain("schemaVersion mismatch");
  });
});