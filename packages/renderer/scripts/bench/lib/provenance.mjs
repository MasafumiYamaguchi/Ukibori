// #46 cross-document provenance validation: every result document fed to
// the benchmark report must share the same schemaVersion, the same runner
// commit, and a clean (non-dirty) generating tree. Returns the first
// problem or null. Lives in the bench lib (same-directory importable by
// the unit tests, which the cross-directory `.mjs` import of the report
// script cannot be under this vitest transform).

export function crossDocumentProvenanceProblem(docs) {
  if (docs.length === 0) {
    return "no result documents";
  }
  const firstDoc = docs[0];
  for (const [index, doc] of docs.entries()) {
    if (doc.schemaVersion !== firstDoc.schemaVersion) {
      return `schemaVersion mismatch (doc ${index}: ${doc.schemaVersion}, first: ${firstDoc.schemaVersion})`;
    }
    if (doc.commit !== firstDoc.commit) {
      return `commit mismatch (doc ${index}: ${doc.commit}, first: ${firstDoc.commit}) ` +
        "— results from different runner commits must not be merged into one report";
    }
    if (doc.workingTreeDirty !== false) {
      return `doc ${index} was generated on a DIRTY working tree ` +
        `(workingTreeDirty=${doc.workingTreeDirty}) — only clean-tree baselines may be reported`;
    }
  }
  return null;
}