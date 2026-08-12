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
