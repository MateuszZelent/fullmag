import { describe, expect, it } from "vitest";

import { selectionRefEquals } from "./selectionTypes";

function postprocessingRef(overrides: Record<string, unknown> = {}) {
  return {
    catalogRevision: 12,
    contractGap: null,
    definitionKind: "table",
    freshness: "fresh",
    kind: "results.tables.definition",
    nodeId: "results:run:run-7:tables:table-energy",
    ownerId: "energy",
    ownerKind: "table",
    ownerReadiness: "available-ready",
    ownerResourceRevision: 8,
    ownerSchemaRevision: 3,
    resourceRef: "table:energy",
    scope: "definition",
    type: "postprocessing",
    ...overrides,
  } as never;
}

function analysisReferenceRef(overrides: Record<string, unknown> = {}) {
  return {
    definitionId: "reference:definition-1",
    kind: "analysis.dispersion.reference",
    nodeId: "results:run:run-7:comparison:reference-1",
    runId: "run-7",
    stageId: "stage-3",
    type: "analysis-reference",
    ...overrides,
  } as never;
}

describe("postprocessing selection identity", () => {
  it("changes equality when the owner catalog revision changes", () => {
    const first = postprocessingRef();
    expect(selectionRefEquals(first, postprocessingRef())).toBe(true);
    expect(selectionRefEquals(
      first,
      postprocessingRef({ catalogRevision: 13, ownerResourceRevision: 9 }),
    )).toBe(false);
  });

  it.each([
    ["available-ready", "fresh"],
    ["loading", "unknown"],
    ["stale", "stale"],
    ["error", "unknown"],
    ["unavailable", "unknown"],
  ] as const)("retains typed owner readiness %s", (ownerReadiness, freshness) => {
    const first = postprocessingRef({ ownerReadiness, freshness });
    expect(selectionRefEquals(first, postprocessingRef({ ownerReadiness, freshness }))).toBe(true);
    expect(selectionRefEquals(first, postprocessingRef({ ownerReadiness: "unavailable", freshness }))).toBe(
      ownerReadiness === "unavailable",
    );
  });
});

describe("imported reference selection identity", () => {
  it("compares definition, run, stage, and node as an independent identity", () => {
    const first = analysisReferenceRef();
    expect(selectionRefEquals(first, analysisReferenceRef())).toBe(true);
    for (const changed of [
      { definitionId: "reference:definition-2" },
      { runId: "run-8" },
      { stageId: "stage-4" },
      { nodeId: "results:run:run-7:comparison:reference-2" },
    ]) {
      expect(selectionRefEquals(first, analysisReferenceRef(changed))).toBe(false);
    }
    expect(selectionRefEquals(first, postprocessingRef())).toBe(false);
  });
});
