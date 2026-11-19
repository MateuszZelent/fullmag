"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, DoubleSide, MeshMatcapMaterial } from "three";

import type { SavedAntennaSourceModel } from "../model/savedAntennaSourceModel";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import { createAntennaPrimitiveTextures } from "./antennaPrimitiveTextures";

export function createSavedAntennaSourceGeometry(model: SavedAntennaSourceModel): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(model.positions, 3));
  geometry.setIndex(new BufferAttribute(model.triangles, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const axes = [0, 1, 2].sort((a, b) => (model.bounds?.size[b] ?? 0) - (model.bounds?.size[a] ?? 0));
  const uv = new Float32Array(model.positions.length / 3 * 2);
  for (let node = 0; node < model.positions.length / 3; node += 1) {
    for (let coordinate = 0; coordinate < 2; coordinate += 1) {
      const axis = axes[coordinate]!;
      const span = model.bounds?.size[axis] ?? 0;
      uv[node * 2 + coordinate] = span > 0
        ? (model.positions[node * 3 + axis]! - (model.bounds!.center[axis]! - span / 2)) / span
        : 0;
    }
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  return geometry;
}

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
