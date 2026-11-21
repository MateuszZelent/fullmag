import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type { HysteresisReplayGlyphAxis, HysteresisReplayGlyphModel } from "../model/viewport3DTargets";

interface HysteresisReplayGlyphLayerAxisModel {
  color: string;
  key: "fieldDirection" | "measurementAxis" | "sampleNormal";
  label: string;
  positions: [number, number, number, number, number, number];
}

interface HysteresisReplayGlyphLayerLabelModel {
  key: HysteresisReplayGlyphLayerAxisModel["key"];
  label: string;
  position: [number, number, number];
}

export interface HysteresisReplayGlyphLayerModel {
  axes: HysteresisReplayGlyphLayerAxisModel[];
  labels: HysteresisReplayGlyphLayerLabelModel[];
  signature: string;
}

export function buildHysteresisReplayGlyphLayerModel({
  bounds,
  glyphModel,
}: {
  bounds: Viewport3DBounds | null;
  glyphModel: HysteresisReplayGlyphModel | null;
}): HysteresisReplayGlyphLayerModel | null {
  if (!bounds || !glyphModel) return null;
  const axes = [
    buildGlyphAxis("fieldDirection", glyphModel.fieldDirection, bounds),
    buildGlyphAxis("measurementAxis", glyphModel.measurementAxis, bounds),
    buildGlyphAxis("sampleNormal", glyphModel.sampleNormal, bounds),
  ].filter((axis): axis is HysteresisReplayGlyphLayerAxisModel => axis !== null);
  if (axes.length === 0) return null;
  return {
    axes,
    labels: axes.map((axis) => ({
      key: axis.key,
      label: axis.label,
      position: axis.positions.slice(3) as [number, number, number],
    })),
    signature: [
      glyphModel.targetId,
      ...axes.map((axis) => `${axis.key}:${axis.positions.slice(3).join(",")}`),
    ].join(":"),
  };
}

function buildGlyphAxis(
  key: HysteresisReplayGlyphLayerAxisModel["key"],
  axis: HysteresisReplayGlyphAxis | null,
  bounds: Viewport3DBounds,
): HysteresisReplayGlyphLayerAxisModel | null {
  if (!axis) return null;
  const length = Math.max(bounds.radius * 0.3, 1e-12);
  const start = bounds.center;
  const end: [number, number, number] = [
    start[0] + axis.vector[0] * length,
    start[1] + axis.vector[1] * length,
    start[2] + axis.vector[2] * length,
  ];
  return {
    color: glyphAxisColor(key),
    key,
    label: axis.label,
    positions: [start[0], start[1], start[2], end[0], end[1], end[2]],
  };
}

function glyphAxisColor(
  key: HysteresisReplayGlyphLayerAxisModel["key"],
): string {
  switch (key) {
    case "fieldDirection":
      return "var(--fm-warning)";
    case "measurementAxis":
      return "var(--fm-info)";
    case "sampleNormal":
      return "var(--fm-stale)";
  }
}
