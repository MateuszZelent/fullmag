"use client";

import { memo, useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { HysteresisReplayGlyphModel } from "../model/viewport3DTargets";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import { buildHysteresisReplayGlyphLayerModel } from "./HysteresisReplayGlyphLayer.model";

const CSS_VARIABLE_COLOR_PATTERN = /^var\((--[-_a-zA-Z0-9]+)\)$/;

function resolveCssColorToken(color: string): string {
  const match = CSS_VARIABLE_COLOR_PATTERN.exec(color.trim());
  if (!match || typeof document === "undefined") return color;

  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1])
    .trim();
  return resolved || color;
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
  const invalidate = useBatchedInvalidate("field-buffer");
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
            color={resolveCssColorToken(axis.color)}
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
