import { describe, expect, it } from "vitest";

import {
  AIRBOX_TARGET_ID,
  canonicalVisualizationTargetId,
  FDM_OUTSIDE_SUPPORT_CARRIER_ID,
} from "./visualizationTargetIdentity";

describe("canonical visualization target identity", () => {
  it.each([
    AIRBOX_TARGET_ID,
    FDM_OUTSIDE_SUPPORT_CARRIER_ID,
    "part:__air__",
    "object:__air__",
  ])("canonicalizes Airbox target alias %s", (targetId) => {
    expect(canonicalVisualizationTargetId(targetId)).toBe("airbox");
  });

  it("does not rewrite non-Airbox target ids", () => {
    expect(canonicalVisualizationTargetId("object:film")).toBe("object:film");
  });
});
