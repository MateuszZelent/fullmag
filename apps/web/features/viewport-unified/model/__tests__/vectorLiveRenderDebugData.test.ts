import { describe, expect, it } from "vitest";

import { buildVectorLiveRenderDebugData } from "../vectorLiveRenderDebugData";

describe("buildVectorLiveRenderDebugData", () => {
  it("preserves vector field source and revision metadata", () => {
    expect(
      buildVectorLiveRenderDebugData({
        source: "live",
        fieldDataRevision: "field:9",
        fieldDataTimestamp: 123,
        liveFieldSourceStep: 5,
        previewSourceStep: 3,
        effectiveStep: 5,
      }),
    ).toEqual({
      source: "live",
      fieldDataRevision: "field:9",
      fieldDataTimestamp: 123,
      liveFieldSourceStep: 5,
      previewSourceStep: 3,
      effectiveStep: 5,
    });
  });
});
