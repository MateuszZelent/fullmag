import {
  type InstancedMesh,
  type Intersection,
  Matrix4,
  Mesh,
  Ray,
  type Raycaster,
  Vector3,
} from "three";
import type { FdmCuboidPickingGrid } from "./fdmCuboidBuildModel";

type GridShape = readonly [number, number, number];
type FdmCuboidHit = Pick<Intersection, "distance" | "point"> & { instanceId: number };

function indexRenderedCells(cells: Uint32Array): (cell: number) => number {
  if (cells.some((cell, index) => index > 0 && cell < cells[index - 1])) {
    const instances = new Map<number, number>();
    for (const [instance, cell] of cells.entries()) {
      if (!instances.has(cell)) instances.set(cell, instance);
    }
    return (cell) => instances.get(cell) ?? -1;
  }

  // Builders emit ordered cells. Avoid a second large index for this case.
  return (cell) => {
    let first = 0;
    let end = cells.length;
    while (first < end) {
      const middle = first + Math.floor((end - first) / 2);
      if (cells[middle] < cell) first = middle + 1;
      else end = middle;
    }
    return cells[first] === cell ? first : -1;
  };
}

function appendAdjacentCells(offsets: number[], stride: number): void {
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    offsets.push(offsets[index] + stride);
  }
}

function coincidentGridPlane(coordinate: number): number | null {
  const plane = Math.round(coordinate);
  return Math.abs(coordinate - plane) <= 8 * Number.EPSILON * Math.max(1, Math.abs(coordinate))
    ? plane
    : null;
}

function traceGrid(
  ray: Ray,
  grid: FdmCuboidPickingGrid,
  shape: GridShape,
  intersectCell: (cell: number) => FdmCuboidHit | null,
  localHitDistance: (point: Vector3) => number,
): FdmCuboidHit | null {
  const start = ray.origin.toArray().map((coord, axis) => (coord - grid.origin[axis]) / grid.spacing[axis]);
  const direction = ray.direction.toArray().map((coord, axis) => coord / grid.spacing[axis]);
  const step = direction.map(Math.sign);
  let entry = 0;
  let exit = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const coord = start[axis];
    const speed = direction[axis];
    const size = shape[axis];
    if (speed === 0) {
      if (coord < 0 || coord > size) return null;
      continue;
    }
    const near = -coord / speed;
    const far = (size - coord) / speed;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
  }
  if (entry > exit || !Number.isFinite(exit)) return null;

  const strides = [1, shape[0], shape[0] * shape[1]];
  const parallelOffsets = [0];
  const entryOffsets = [0];
  const cell = start.map((coord, axis) => {
    const intersect = coord + entry * direction[axis];
    const plane = coincidentGridPlane(intersect);
    if (plane !== null && plane > 0 && plane < shape[axis]) {
      if (step[axis] === 0) appendAdjacentCells(parallelOffsets, -strides[axis]);
      else appendAdjacentCells(entryOffsets, -step[axis] * strides[axis]);
    }
    const coordinate = plane ?? intersect;
    const index = step[axis] < 0 ? Math.ceil(coordinate) - 1 : Math.floor(coordinate);
    return Math.max(0, Math.min(shape[axis] - 1, index));
  });
  const crossing = cell.map((index, axis) => step[axis] === 0
    ? Infinity
    : (index + Number(step[axis] > 0) - start[axis]) / direction[axis]);
  const delta = direction.map((speed) => Math.abs(1 / speed));
  let cellId = cell[0] + strides[1] * cell[1] + strides[2] * cell[2];
  let closest: FdmCuboidHit | null = null;
  const visit = (id: number, best: FdmCuboidHit | null) => {
    for (const offset of parallelOffsets) {
      const hit = intersectCell(id + offset);
      if (hit && (
        !best || hit.distance < best.distance ||
        (hit.distance === best.distance && hit.instanceId < best.instanceId)
      )) best = hit;
    }
    return best;
  };
  for (const offset of entryOffsets) {
    if (offset !== 0) closest = visit(cellId + offset, closest);
  }

  // Amanatides–Woo DDA. Closed cuboid faces can also hit the cells touched
  // at a shared face, edge, or corner without entering their interiors.
  while (true) {
    closest = visit(cellId, closest);
    const next = Math.min(crossing[0], crossing[1], crossing[2]);
    const tolerance = 16 * Number.EPSILON * Math.abs(next);
    if (closest && localHitDistance(closest.point) < next - tolerance) return closest;
    if (next > exit + tolerance) return closest;

    let crossedCount = 0;
    let leaving = false;
    let destinationOffset = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      if (crossing[axis] > next + tolerance) continue;
      crossedCount += 1;
      cell[axis] += step[axis];
      leaving ||= cell[axis] < 0 || cell[axis] >= shape[axis];
      destinationOffset += step[axis] * strides[axis];
    }
    if (crossedCount > 1) {
      const boundaryOffsets = [0];
      for (let axis = 0; axis < 3; axis += 1) {
        if (crossing[axis] <= next + tolerance && cell[axis] >= 0 && cell[axis] < shape[axis]) {
          appendAdjacentCells(boundaryOffsets, step[axis] * strides[axis]);
        }
      }
      for (const offset of boundaryOffsets) {
        if (offset !== 0 && (leaving || offset !== destinationOffset)) {
          closest = visit(cellId + offset, closest);
        }
      }
    }
    if (leaving) return closest;
    cellId += destinationOffset;
    for (let axis = 0; axis < 3; axis += 1) {
      if (crossing[axis] > next + tolerance) continue;
      crossing[axis] += delta[axis];
    }
  }
}

export function createFdmCuboidGridPicker(
  grid: FdmCuboidPickingGrid,
  shape: GridShape,
  cellIndices: Uint32Array,
): (raycaster: Raycaster, targets: readonly InstancedMesh[]) => FdmCuboidHit | null {
  const instanceForCell = indexRenderedCells(cellIndices);
  const inverseWorld = new Matrix4();
  const instanceMatrix = new Matrix4();
  const localRay = new Ray();
  const localPoint = new Vector3();
  let mesh: Mesh | undefined;
  const hits: Intersection[] = [];

  return (raycaster, targets) => {
    let closest: FdmCuboidHit | null = null;
    for (const target of targets) {
      if (!target.visible || target.count === 0 || !raycaster.layers.test(target.layers)) continue;
      inverseWorld.copy(target.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverseWorld);
      const candidate = mesh ??= new Mesh(target.geometry, target.material);
      candidate.geometry = target.geometry;
      candidate.material = target.material;

      const hit = traceGrid(localRay, grid, shape, (cell) => {
        const instanceId = instanceForCell(cell);
        if (instanceId < 0 || instanceId >= target.count) return null;

        // Test the actual box, including the fill gap, material side and clipping.
        target.getMatrixAt(instanceId, instanceMatrix);
        candidate.matrixWorld.multiplyMatrices(target.matrixWorld, instanceMatrix);
        hits.length = 0;
        candidate.raycast(raycaster, hits);
        let nearest = hits[0];
        for (let index = 1; index < hits.length; index += 1) {
          if (hits[index].distance < nearest.distance) nearest = hits[index];
        }
        return nearest ? { distance: nearest.distance, point: nearest.point, instanceId } : null;
      }, (point) => localPoint.copy(point).applyMatrix4(inverseWorld)
        .sub(localRay.origin).dot(localRay.direction));
      if (hit && (!closest || hit.distance < closest.distance)) closest = hit;
    }
    return closest;
  };
}
