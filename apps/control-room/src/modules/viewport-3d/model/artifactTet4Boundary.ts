import { buildAveragedSurfaceNodeNormals } from "../viewport3dRenderModel";
import { deviceBoundary, MAX_ANTENNA_DISPLAY_CELLS, MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES } from "./antennaFieldOverlayModel";

/** Join geometry by exact stable identity, while keeping every cell-local field slot. */
export function artifactCellLocalBoundary(positions: Float64Array, stableIds: BigUint64Array) {
  const count = stableIds.length;
  if (!count || count % 4 || count > MAX_ANTENNA_DISPLAY_CELLS * 4 || positions.length !== count * 3 ||
      positions.byteLength + stableIds.byteLength + count * 4 > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) {
    throw new Error("Cell-local Tet4 geometry exceeds its complete display bound.");
  }
  const physical = new Map<bigint, number>();
  const coordinates = new Float64Array(positions.length), connectivity = new Uint32Array(count);
  const representative = new Uint32Array(count);
  for (let slot = 0; slot < count; slot++) {
    const id = stableIds[slot];
    const existing = physical.get(id), fresh = existing === undefined;
    const node = existing ?? physical.size;
    if (fresh) { physical.set(id, node); representative[node] = slot; }
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[slot * 3 + axis];
      if (!Number.isFinite(value)) throw new Error("Non-finite cell-local coordinate.");
      if (fresh) coordinates[node * 3 + axis] = value;
      else if (!Object.is(coordinates[node * 3 + axis], value)) throw new Error("Stable vertex identity has inconsistent coordinates.");
    }
    connectivity[slot] = node;
  }
  const physicalPositions = coordinates.slice(0, physical.size * 3);
  const boundary = deviceBoundary(physicalPositions.buffer, connectivity.buffer, physical.size);
  const physicalNormals = buildAveragedSurfaceNodeNormals({ nodeCount: physical.size, positions: physicalPositions }, boundary.triangles);
  const surfaceNormals = physicalNormals ? new Float32Array(count * 3) : null;
  if (surfaceNormals && physicalNormals) for (let slot = 0; slot < count; slot++) for (let axis = 0; axis < 3; axis++) {
    surfaceNormals[slot * 3 + axis] = physicalNormals[connectivity[slot] * 3 + axis];
  }
  // Wireframe has no field attributes: any exact geometric representative is sufficient.
  const edges = Uint32Array.from(boundary.edges, node => representative[node]);
  return { triangles: boundary.localTriangles, edges, surfaceNormals };
}
