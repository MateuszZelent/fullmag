import { describe, expect, it } from "vitest";

import { parseStudyNodeContext } from "../node-context";

describe("study node context", () => {
  it("maps legacy defaults nodes to stage root fallback", () => {
    expect(parseStudyNodeContext("study-defaults")).toEqual({ kind: "study-stages" });
    expect(parseStudyNodeContext("study-defaults-runtime")).toEqual({ kind: "study-stages" });
    expect(parseStudyNodeContext("study-defaults-physics")).toEqual({ kind: "study-stages" });
    expect(parseStudyNodeContext("study-defaults-outputs")).toEqual({ kind: "study-stages" });
  });

  it("keeps stage detail parsing intact", () => {
    expect(parseStudyNodeContext("study-stage-node:stage-1/solver")).toEqual({
      kind: "study-stage",
      source: "pipeline",
      stageKey: "stage-1",
      detail: "solver",
    });
  });
});
