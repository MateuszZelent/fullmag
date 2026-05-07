export type SliceAxis = "x" | "y" | "z";
export type SlicePlane = "xy" | "xz" | "yz";
export type SliceGrid = [number, number, number];
export interface SliceAxisBounds {
  min: number;
  max: number;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

function axisIndex(axis: SliceAxis): 0 | 1 | 2 {
  if (axis === "x") return 0;
  if (axis === "y") return 1;
  return 2;
}

export function sliceAxisFromPlane(plane: SlicePlane): SliceAxis {
  if (plane === "yz") return "x";
  if (plane === "xz") return "y";
  return "z";
}

export function planeFromSliceAxis(axis: SliceAxis): SlicePlane {
  if (axis === "x") return "yz";
  if (axis === "y") return "xz";
  return "xy";
}

export function resolveEffectiveSlicePlane(args: {
  plane: SlicePlane;
  clipAxis?: SliceAxis | null;
  preferClipAxis: boolean;
}): SlicePlane {
  if (args.preferClipAxis && args.clipAxis) {
    return planeFromSliceAxis(args.clipAxis);
  }
  return args.plane;
}

export function resolveSliceAxisSelection(args: {
  axis: SliceAxis;
  syncClipAxis: boolean;
}): { plane: SlicePlane; clipAxis: SliceAxis | null } {
  const { axis, syncClipAxis } = args;
  return {
    plane: planeFromSliceAxis(axis),
    clipAxis: syncClipAxis ? axis : null,
  };
}

export function sliceDepthForPlane(
  grid: SliceGrid,
  plane: SlicePlane,
): number {
  if (plane === "xy") return Math.max(grid[2], 1);
  if (plane === "xz") return Math.max(grid[1], 1);
  return Math.max(grid[0], 1);
}

export function sliceIndexFromPositionPercent(args: {
  grid: SliceGrid;
  plane: SlicePlane;
  positionPercent: number;
}): number {
  const { grid, plane, positionPercent } = args;
  const depth = sliceDepthForPlane(grid, plane);
  if (depth <= 1) return 0;
  const maxIndex = depth - 1;
  return Math.max(0, Math.min(maxIndex, Math.round((clampPercent(positionPercent) / 100) * maxIndex)));
}

export function positionPercentFromSliceIndex(args: {
  grid: SliceGrid;
  plane: SlicePlane;
  sliceIndex: number;
}): number {
  const { grid, plane, sliceIndex } = args;
  const depth = sliceDepthForPlane(grid, plane);
  if (depth <= 1) return 50;
  const maxIndex = depth - 1;
  const clampedIndex = Math.max(0, Math.min(maxIndex, Math.trunc(sliceIndex)));
  return (clampedIndex / maxIndex) * 100;
}

export function worldPositionFromPercent(
  min: number,
  max: number,
  percent: number,
): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  if (Math.abs(max - min) <= 1e-18) {
    return min;
  }
  const t = clampPercent(percent) / 100;
  return min + (max - min) * t;
}

export function percentFromWorldPosition(
  min: number,
  max: number,
  world: number,
): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(world)) {
    return 50;
  }
  if (Math.abs(max - min) <= 1e-18) {
    return 0;
  }
  return clampPercent(((world - min) / (max - min)) * 100);
}

export function formatWorldPosition(meters: number): string {
  if (!Number.isFinite(meters)) {
    return "0 nm";
  }
  const abs = Math.abs(meters);
  if (abs >= 1e-3) {
    return `${(meters * 1e3).toFixed(3)} mm`;
  }
  if (abs >= 1e-6) {
    return `${(meters * 1e6).toFixed(3)} um`;
  }
  return `${(meters * 1e9).toFixed(3)} nm`;
}

export function sliceAxisBoundsFromMesh(
  nodes: ArrayLike<number>,
  nNodes: number,
  axis: SliceAxis,
): SliceAxisBounds {
  const offset = axisIndex(axis);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < nNodes; i += 1) {
    const value = Number(nodes[i * 3 + offset]);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0 };
  }
  return { min, max };
}

export function sliceAxisMagneticExtent(
  nodes: ArrayLike<number>,
  nNodes: number,
  axis: SliceAxis,
  visibleElements?: Uint8Array | null,
  elements?: ArrayLike<number> | null,
): SliceAxisBounds | null {
  if (!elements || elements.length === 0) {
    return null;
  }
  const offset = axisIndex(axis);
  const nElements = Math.floor(elements.length / 4);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let elementIndex = 0; elementIndex < nElements; elementIndex += 1) {
    if (visibleElements && visibleElements[elementIndex] !== 1) {
      continue;
    }
    const base = elementIndex * 4;
    for (let localNode = 0; localNode < 4; localNode += 1) {
      const nodeIndex = Math.trunc(Number(elements[base + localNode]));
      if (nodeIndex < 0 || nodeIndex >= nNodes) {
        continue;
      }
      const value = Number(nodes[nodeIndex * 3 + offset]);
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }
  return { min, max };
}
