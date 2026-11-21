"use client";

import { useEffect, useMemo } from "react";
import { DoubleSide, MeshMatcapMaterial } from "three";

import type { SavedAntennaSourceModel } from "../model/savedAntennaSourceModel";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import { createAntennaPrimitiveTextures } from "./antennaPrimitiveTextures";
import { createSavedAntennaSourceGeometry } from "./SavedAntennaSourceLayer.model";

export function SavedAntennaSourceLayer({ model, colors, tracker }: {
  model: SavedAntennaSourceModel | null;
  colors: Viewport3DColors;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();
  const geometry = useMemo(() => model ? createSavedAntennaSourceGeometry(model) : null, [model]);
  const enabled = model !== null;
  const color = colors.antenna ?? colors.mesh;
  const owned = useMemo(() => {
    if (!enabled) return null;
    const textures = createAntennaPrimitiveTextures();
    const material = new MeshMatcapMaterial({
      color, map: textures.brush, matcap: textures.matcap, side: DoubleSide, flatShading: true,
    });
    return { material, textures };
  }, [enabled, color]);

  useEffect(() => {
    if (!geometry) return;
    tracker.track("geometry", geometry, {
      owner: "saved-antenna-source",
      byteLength: Object.values(geometry.attributes).reduce((sum, attribute) =>
        sum + attribute.array.byteLength, geometry.index?.array.byteLength ?? 0),
    });
    invalidate();
    return () => { tracker.release("geometry", geometry); invalidate(); };
  }, [geometry, invalidate, tracker]);
  useEffect(() => {
    if (!owned) return;
    tracker.track("material", owned.material, { owner: "saved-antenna-source" });
    for (const texture of Object.values(owned.textures)) {
      tracker.track("texture", texture, { owner: "saved-antenna-source", byteLength: 64 * 64 * 4 });
    }
    invalidate();
    return () => {
      tracker.release("material", owned.material);
      for (const texture of Object.values(owned.textures)) tracker.release("texture", texture);
      invalidate();
    };
  }, [invalidate, owned, tracker]);

  return model && geometry && owned ? <mesh
    name="saved-antenna-source-context"
    geometry={geometry}
    material={owned.material}
    dispose={null}
    userData={{ geometryObjectRef: model.key, fieldCapable: false, archived: true }}
  /> : null;
}
