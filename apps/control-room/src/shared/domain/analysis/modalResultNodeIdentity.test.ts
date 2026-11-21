import { describe, expect, it } from "vitest";

import { modalSpectrumMatchesSelection } from "./modalResultNodeIdentity";

describe("modalSpectrumMatchesSelection", () => {
  it("keeps the current run and exact stage together", () => {
    const publication = { run_id: "run-1", stage_id: "stage-2" };

    expect(modalSpectrumMatchesSelection(publication, {
      analysisRunId: "run-1", analysisStageId: "stage-2",
    })).toBe(true);
    expect(modalSpectrumMatchesSelection(publication, {
      analysisRunId: "run-1", analysisStageId: "stage-1",
    })).toBe(false);
    expect(modalSpectrumMatchesSelection(publication, {
      analysisRunId: "run-2", analysisStageId: "stage-2",
    })).toBe(false);
    expect(modalSpectrumMatchesSelection(null, null)).toBe(false);
  });
});
