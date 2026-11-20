"use client";

import { useEffect, useMemo } from "react";
import { type ColorRepresentation } from "three";

import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";

import { type FrozenSpinsOverlayModel, createFrozenSpinsOverlayResources } from "./FrozenSpinsOverlay.model";

export function FrozenSpinsOverlay({
  color,
  model,
  tracker,
}: {
  color: ColorRepresentation;
  model: FrozenSpinsOverlayModel;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate("frozen-spins-overlay");
  const resources = useMemo(
    () => createFrozenSpinsOverlayResources(model.positions, color),
    [color, model.positions],
  );
  const { geometry, material } = resources;

  useEffect(() => {
    tracker.track("geometry", geometry, {
      byteLength: model.positions.byteLength,
      label: "Frozen Spins overlay positions",
      owner: `frozen-spins:${model.previewId}`,
    });
    tracker.track("material", material, {
      label: "Frozen Spins overlay material",
      owner: `frozen-spins:${model.previewId}`,
    });
    tracker.recordDirtyFrame("frozen-spins-overlay");
    invalidate();
    return () => {
      tracker.release("geometry", geometry, "frozen-spins-overlay-cleanup");
      tracker.release("material", material, "frozen-spins-overlay-cleanup");
      tracker.recordDirtyFrame("frozen-spins-overlay-cleanup");
      invalidate();
    };
  }, [geometry, invalidate, material, model.positions.byteLength, model.previewId, tracker]);

  return (
    <points
      frustumCulled
      geometry={geometry}
      material={material}
      renderOrder={120}
      userData={{
        carrierKind: model.carrierKind,
        previewId: model.previewId,
      }}
    />
  );
}
