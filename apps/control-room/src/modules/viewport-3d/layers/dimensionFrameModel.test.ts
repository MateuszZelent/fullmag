import { describe, expect, it } from "vitest";

import type { Viewport3DBounds } from "../viewport3dRenderModel";
import {
  buildDimensionFrameModel,
  formatDimensionFrameTickValue,
  resolveDimensionFrameEdges,
  resolveDimensionFrameStep,
  resolveDimensionFrameUnit,
} from "./dimensionFrameModel";

const bounds: Viewport3DBounds = {
  center: [0, 0, 0],
  radius: Math.hypot(100e-9, 80e-9, 20e-9) / 2,
  size: [100e-9, 80e-9, 20e-9],
};

const cameraState = {
  position: [1e-6, 1e-6, 1e-6] as [number, number, number],
  target: [0, 0, 0] as [number, number, number],
  up: [0, 0, 1] as [number, number, number],
};

describe("resolveDimensionFrameUnit", () => {
  it("uses nm for nanoscale magnetic domains", () => {
    expect(resolveDimensionFrameUnit(250e-9, "auto")).toEqual({
      factor: 1e9,
      id: "nm",
      label: "nm",
    });
  });

  it("uses um for micrometer domains", () => {
    expect(resolveDimensionFrameUnit(12e-6, "auto").id).toBe("um");
  });

  it("uses mm for millimeter domains", () => {
    expect(resolveDimensionFrameUnit(0.4, "auto").id).toBe("mm");
  });

  it("honors explicit unit mode", () => {
    expect(resolveDimensionFrameUnit(100e-9, "um").id).toBe("um");
  });
});

describe("formatDimensionFrameTickValue", () => {
  it("formats compact physical tick values in selected units", () => {
    const nm = resolveDimensionFrameUnit(250e-9, "nm");
    const um = resolveDimensionFrameUnit(4e-6, "um");

    expect(formatDimensionFrameTickValue(0, nm)).toBe("0");
    expect(formatDimensionFrameTickValue(125e-9, nm)).toBe("125");
    expect(formatDimensionFrameTickValue(1.25e-6, um)).toBe("1.25");
  });
});

describe("resolveDimensionFrameStep", () => {
  it("uses nice 1-2-5 steps", () => {
    expect(resolveDimensionFrameStep(100e-9, "auto")).toBeCloseTo(20e-9);
    expect(resolveDimensionFrameStep(900e-9, "auto")).toBeCloseTo(200e-9);
    expect(resolveDimensionFrameStep(3.2e-6, "coarse")).toBeCloseTo(1e-6);
  });
});

describe("buildDimensionFrameModel", () => {
  it("selects the floor and camera-facing vertical cage planes", () => {
    const model = buildDimensionFrameModel({
      bounds,
      cameraProjection: "perspective",
      cameraState,
      density: "auto",
      labelsVisible: true,
      mode: "cage",
      unitMode: "auto",
    });

    expect(model.mode).toBe("cage");
    expect(model.planes.map((plane) => plane.id)).toEqual(["xy-min", "x-min", "y-min"]);
    expect(model.unit.id).toBe("nm");
    expect(model.majorLines.length).toBeGreaterThan(0);
    expect(model.minorLines.length).toBeGreaterThan(0);
    const tickLabels = model.labels.filter((label) => label.kind === "tick");
    expect(tickLabels.length).toBeGreaterThan(0);
    expect(tickLabels.length).toBeLessThanOrEqual(36);
    expect(model.majorTickLines.length).toBeGreaterThan(0);
  });

  it("switches vertical cage planes from camera quadrant", () => {
    const model = buildDimensionFrameModel({
      bounds,
      cameraProjection: "perspective",
      cameraState: {
        ...cameraState,
        position: [-1e-6, 1e-6, 1e-6],
      },
      density: "auto",
      labelsVisible: true,
      mode: "cage",
      unitMode: "auto",
    });

    expect(model.planes.map((plane) => plane.id)).toEqual(["xy-min", "x-max", "y-min"]);
  });

  it("renders only the floor in floor mode", () => {
    const model = buildDimensionFrameModel({
      bounds,
      cameraProjection: "orthographic",
      cameraState,
      density: "auto",
      labelsVisible: true,
      mode: "floor",
      unitMode: "auto",
    });

    expect(model.planes.map((plane) => plane.id)).toEqual(["xy-min"]);
  });

  it("returns an empty model when disabled", () => {
    const model = buildDimensionFrameModel({
      bounds,
      cameraProjection: "perspective",
      cameraState,
      density: "fine",
      labelsVisible: true,
      mode: "off",
      unitMode: "auto",
    });

    expect(model.planes).toEqual([]);
    expect(model.majorLines).toHaveLength(0);
    expect(model.minorLines).toHaveLength(0);
    expect(model.labels).toHaveLength(0);
    expect(model.majorTickLines).toHaveLength(0);
  });

  it("puts the scale on the floor edges facing the camera", () => {
    const box = { max: [1, 2, 3] as [number, number, number], min: [-1, -2, -3] as [number, number, number] };
    const front = resolveDimensionFrameEdges(box, cameraState);
    expect(front.map((edge) => edge.id)).toEqual(["x@ymax", "y@xmax", "z@xmaxymin"]);
    expect(front[0]?.outward).toEqual([0, 1, 0]);

    const behind = resolveDimensionFrameEdges(box, {
      ...cameraState,
      position: [-1e-6, -1e-6, 1e-6],
    });
    expect(behind.map((edge) => edge.id)).toEqual(["x@ymin", "y@xmin", "z@xminymax"]);
  });

  it("titles each annotated axis with its unit", () => {
    const model = buildDimensionFrameModel({
      bounds,
      cameraProjection: "perspective",
      cameraState,
      density: "auto",
      labelsVisible: true,
      mode: "floor",
      unitMode: "auto",
    });

    const titles = model.labels.filter((label) => label.kind === "title");
    expect(titles.map((label) => [label.text, label.unitLabel])).toEqual([
      ["x", "nm"],
      ["y", "nm"],
      ["z", "nm"],
    ]);
    expect(model.extentLines).toHaveLength(0);
  });

  it("draws overall extents instead of ticks in extents mode", () => {
    const model = buildDimensionFrameModel({
      annotation: "extents",
      bounds,
      cameraProjection: "perspective",
      cameraState,
      density: "auto",
      labelsVisible: true,
      mode: "floor",
      unitMode: "auto",
    });

    expect(model.majorTickLines).toHaveLength(0);
    expect(model.extentLines.length).toBeGreaterThan(0);
    expect(
      model.labels.map((label) => [label.kind, label.axis, label.text, label.unitLabel]),
    ).toEqual([
      ["extent", "x", "100", "nm"],
      ["extent", "y", "80", "nm"],
      ["extent", "z", "20", "nm"],
    ]);
  });

  it("labels each tick once when the span is tiny relative to its centre", () => {
    const model = buildDimensionFrameModel({
      bounds: { center: [1e-3, 1e-3, 1e-3], radius: 1e-15, size: [2e-15, 2e-15, 2e-15] },
      cameraProjection: "perspective",
      cameraState,
      density: "auto",
      labelsVisible: true,
      mode: "floor",
      unitMode: "auto",
    });

    const keys = model.labels.map((label) => label.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
