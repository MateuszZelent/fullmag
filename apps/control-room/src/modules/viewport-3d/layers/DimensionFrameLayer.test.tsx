import { describe, expect, it, vi } from "vitest";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  createDimensionFrameLineGeometry,
  dimensionFrameLabelRuns,
  releaseDimensionFrameGeometry,
  resolveDimensionFrameLayerColors,
  tickThinningForSpacing,
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

  it("outlines labels with the viewport background instead of a grey", () => {
    expect(resolveDimensionFrameLayerColors(colors)).toEqual({
      axis: { x: "#cdd6f4", y: "#cdd6f4", z: "#89b4fa" },
      extent: "#cdd6f4",
      grid: "#bac2de",
      halo: "#11111b",
      label: "#cdd6f4",
      tick: "#bac2de",
    });
  });

  it("prefers the theme HUD palette when it is resolved", () => {
    const resolved = resolveDimensionFrameLayerColors({
      ...colors,
      hud: {
        axisX: "#d20f39",
        axisY: "#40a02b",
        axisZ: "#1e66f5",
        chip: "#eff1f5",
        chipBorder: "#8c8fa1",
        cubeEdge: "#8c8fa1",
        cubeFace: "#eff1f5",
        cubeShade: "#4c4f69",
        grid: "#5c5f77",
        halo: "#dce0e8",
        label: "#4c4f69",
        tick: "#5c5f77",
      },
    });
    expect(resolved.axis).toEqual({ x: "#d20f39", y: "#40a02b", z: "#1e66f5" });
    expect(resolved.halo).toBe("#dce0e8");
  });

  it("titles an axis with its italic letter and unit", () => {
    const { runs } = dimensionFrameLabelRuns(
      {
        axis: "x",
        key: "title:x",
        kind: "title",
        outward: [0, -1, 0],
        pixelOffset: 40,
        position: [0, 0, 0],
        text: "x",
        unitLabel: "nm",
      },
      resolveDimensionFrameLayerColors(colors),
    );
    expect(runs.map((run) => run.text).join("")).toBe("x (nm)");
    expect(runs[0]?.italic).toBe(true);
  });

  it("thins tick numbers when they crowd on screen", () => {
    expect(tickThinningForSpacing(60)).toBe(1);
    expect(tickThinningForSpacing(20)).toBe(2);
    expect(tickThinningForSpacing(6)).toBe(5);
  });
});
