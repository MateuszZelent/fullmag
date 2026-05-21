import { describe, expect, it, vi } from "vitest";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  createDimensionFrameLineGeometry,
  releaseDimensionFrameGeometry,
  resolveDimensionFrameLayerColors,
  trackDimensionFrameGeometry,
} from "./DimensionFrameLayer";

const colors: Viewport3DColors = {
  accent: "#89b4fa",
  background: "#11111b",
  field: "#a6e3a1",
  mesh: "#313244",
  textPrimary: "#cdd6f4",
  textSecondary: "#bac2de",
  wire: "#6c7086",
};

describe("DimensionFrameLayer resources", () => {
  it("does not allocate geometry for empty line buffers", () => {
    expect(createDimensionFrameLineGeometry(new Float32Array())).toBeNull();
  });

  it("tracks and releases line geometry through the viewport tracker", () => {
    const tracker = new Viewport3DResourceTracker();
    const geometry = createDimensionFrameLineGeometry(
      new Float32Array([0, 0, 0, 1, 0, 0]),
    );
    if (!geometry) throw new Error("Expected geometry");
    const dispose = vi.spyOn(geometry, "dispose");

    trackDimensionFrameGeometry(tracker, geometry);
    expect(tracker.getSnapshot().geometries).toBe(1);

    releaseDimensionFrameGeometry(tracker, geometry);

    expect(dispose).toHaveBeenCalledOnce();
    expect(tracker.getSnapshot().geometries).toBe(0);
  });

  it("resolves quiet grid colors from viewport text and wire tokens", () => {
    expect(resolveDimensionFrameLayerColors(colors)).toEqual({
      label: "#cdd6f4",
      major: "#bac2de",
      minor: "#6c7086",
      outline: "#11111b",
    });
  });
});
