import { describe, expect, it } from "vitest";

import {
  AIRBOX_TARGET_ID,
  canonicalVisualizationTargetId,
  FDM_OUTSIDE_SUPPORT_CARRIER_ID,
} from "./visualizationTargetIdentity";

describe("canonical visualization target identity", () => {
  it("canonicalizes the legacy FDM carrier alias to the Airbox target", () => {
    expect(canonicalVisualizationTargetId(AIRBOX_TARGET_ID)).toBe("airbox");
    expect(canonicalVisualizationTargetId(FDM_OUTSIDE_SUPPORT_CARRIER_ID)).toBe("airbox");
  });

  it("does not rewrite non-Airbox target ids", () => {
    expect(canonicalVisualizationTargetId("object:film")).toBe("object:film");
  });
});
