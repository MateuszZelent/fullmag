/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import { DEFAULT_FDM_RENDER_STATE } from "../fdmTypes";

describe("DEFAULT_FDM_RENDER_STATE", () => {
  it("uses deterministic defaults for FDM rendering", () => {
    expect(DEFAULT_FDM_RENDER_STATE).toEqual({
      selectedLayer: 0,
      allLayersVisible: false,
      vectorComponent: "3D",
      colorScale: "viridis",
      autoScale: true,
      maxPoints: 50000,
      everyN: 1,
    });
  });
});
