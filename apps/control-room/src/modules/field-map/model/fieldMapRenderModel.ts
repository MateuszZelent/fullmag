export interface PlanarFrame {
  normal: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
}

export interface PlanarVectorComponents {
  magnitude: number;
  normal: number;
  u: number;
  v: number;
}

function dot(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

export function resolvePlanarVectorComponents(
  vector: readonly [number, number, number],
  frame: PlanarFrame,
  epsilon = 1e-15,
): PlanarVectorComponents {
  const magnitude = Math.hypot(...vector);
  if (magnitude <= epsilon) {
    return { magnitude: 0, normal: 0, u: 0, v: 0 };
  }
  return {
    magnitude,
    normal: dot(vector, frame.normal),
    u: dot(vector, frame.uAxis),
    v: dot(vector, frame.vAxis),
  };
}

export function surfaceProjectionStatus(meta: {
  fold_count: number;
  non_injective: boolean;
  overlap_count: number;
}): "ambiguous" | "resolved" {
  return meta.non_injective || meta.fold_count > 0 || meta.overlap_count > 0
    ? "ambiguous"
    : "resolved";
}
