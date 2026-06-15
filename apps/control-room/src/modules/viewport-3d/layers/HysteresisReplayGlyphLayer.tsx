"use client";

import { useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type {
  HysteresisReplayGlyphAxis,
  HysteresisReplayGlyphModel,
} from "../model/viewport3DTargets";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";

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
      return "#ffcc66";
    case "measurementAxis":
      return "#7dd3fc";
    case "sampleNormal":
      return "#c4b5fd";
  }
}

export const HysteresisReplayGlyphLayer = memo(function HysteresisReplayGlyphLayer({
  bounds,
  glyphModel,
  tracker,
}: {
  bounds: Viewport3DBounds | null;
  glyphModel: HysteresisReplayGlyphModel | null;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const model = useMemo(
    () => buildHysteresisReplayGlyphLayerModel({ bounds, glyphModel }),
    [bounds, glyphModel],
  );
  const geometries = useMemo(() => {
    if (!model) return [];
    return model.axes.map((axis) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array(axis.positions), 3),
      );
      return { axis, geometry };
    });
  }, [model]);

  useEffect(() => {
    geometries.forEach(({ geometry }) => tracker.track("geometry", geometry));
    return () => {
      geometries.forEach(({ geometry }) => tracker.release("geometry", geometry));
    };
  }, [geometries, tracker]);

  useEffect(() => {
    if (!model) return;
    tracker.recordDirtyFrame("hysteresis-replay-glyph");
    invalidate();
  }, [invalidate, model, tracker]);

  if (!model) return null;

  return (
    <group name="hysteresis-replay-glyphs" renderOrder={12}>
      {geometries.map(({ axis, geometry }) => (
        <lineSegments
          key={axis.key}
          geometry={geometry}
          name={`hysteresis-replay-glyph-${axis.key}`}
          renderOrder={12}
          userData={{ label: axis.label }}
        >
          <lineBasicMaterial
            color={axis.color}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      ))}
      {model.labels.map((label) => (
        <group
          key={`label-${label.key}`}
          name={`hysteresis-replay-glyph-label-${label.key}`}
          position={label.position}
          userData={{ label: label.label }}
        />
      ))}
    </group>
  );
});
