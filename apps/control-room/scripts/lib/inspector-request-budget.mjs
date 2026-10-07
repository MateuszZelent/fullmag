// Idempotent reads repeat after each document reload; mutation caps remain
// scenario-scoped so a reload cannot hide duplicate authoring writes.
const DOCUMENT_SCOPED_METHODS = new Set(["GET"]);

export function createInspectorRequestBudgetState() {
  return {
    cumulativeCounts: new Map(),
    documentCounts: new Map(),
    documentId: 0,
    documentLabel: "before-first-document",
  };
}

export function resetInspectorDocumentBudget(state, label) {
  state.documentId += 1;
  state.documentLabel = label;
  state.documentCounts = new Map();
  return state.documentId;
}

export function recordInspectorRequestBudget(
  state,
  { method, requestKey, requestLimit },
) {
  const cumulativeCount = incrementCount(state.cumulativeCounts, requestKey);
  const documentScoped = DOCUMENT_SCOPED_METHODS.has(method);
  const scopedCount = documentScoped
    ? incrementCount(state.documentCounts, requestKey)
    : cumulativeCount;

  return {
    count: scopedCount,
    cumulativeCount,
    documentId: state.documentId,
    exceeded: scopedCount > requestLimit,
    scope: documentScoped ? "document" : "scenario",
  };
}

function incrementCount(counts, key) {
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  return count;
}
