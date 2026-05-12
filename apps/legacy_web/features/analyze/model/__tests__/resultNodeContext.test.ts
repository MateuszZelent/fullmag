import { describe, expect, it } from "vitest";

import { parseResultNodeContext, resultContextToNodeKind } from "../resultNodeContext";

describe("resultNodeContext", () => {
  it("parses typed graph-backed results node ids", () => {
    expect(parseResultNodeContext("res-solution-sol-1")).toEqual({
      kind: "results-solution",
      solutionId: "sol-1",
    });
    expect(parseResultNodeContext("res-derived-value-dv-1")).toEqual({
      kind: "results-derived-value",
      derivedValueId: "dv-1",
    });
    expect(parseResultNodeContext("res-export-exp-1")).toEqual({
      kind: "results-export-node",
      exportId: "exp-1",
    });
  });

  it("maps typed contexts back to registry node kinds", () => {
    expect(
      resultContextToNodeKind({ kind: "results-solution", solutionId: "sol-1" }),
    ).toBe("results.solution");
    expect(
      resultContextToNodeKind({ kind: "results-derived-value", derivedValueId: "dv-1" }),
    ).toBe("results.derived_scalars");
    expect(
      resultContextToNodeKind({ kind: "results-export-node", exportId: "exp-1" }),
    ).toBe("results.export");
  });
});
