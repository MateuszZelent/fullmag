import type { SavedAntennaSourceModel } from "../model/savedAntennaSourceModel";
import { BufferAttribute, BufferGeometry } from "three";

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
