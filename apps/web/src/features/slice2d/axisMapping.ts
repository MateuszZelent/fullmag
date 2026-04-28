export type SliceAxis = "x" | "y" | "z";
export type SlicePlane = "xy" | "xz" | "yz";
export type SliceGrid = [number, number, number];

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
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
