import { isRenderablePlanarOccupancy } from "./planarOccupancy";

export interface PlanarFrame {
  normal: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
}

export interface FieldMapRenderLayers {
  contours: boolean;
  mesh: boolean;
  raster: boolean;
  vectors: boolean;
}

export interface PlanarDisplayRange {
  mode: "auto" | "manual" | "symmetric";
  max?: number;
  min?: number;
}

export interface FieldMapRenderModelInput {
  bounds: readonly [number, number, number, number];
  canonicalUnit: string;
  colormap?: string;
  component: string;
  displayUnit?: string | null;
  frame: PlanarFrame;
  interaction?: { panU: number; panV: number; zoom: number };
  layers: FieldMapRenderLayers;
  mask?: Uint8Array | null;
  meshOverlay?: ArrayBuffer | null;
  opacity?: number;
  range: PlanarDisplayRange;
  resolution: readonly [number, number];
  sampleIdentity: string;
  scalar: Float32Array | Float64Array;
  vectors?: Float32Array | Float64Array | null;
  vectorBudget?: number;
  vectorScale?: number;
}

export interface FieldMapRenderModel {
  bounds: readonly [number, number, number, number];
  boundsCenter: readonly [number, number];
  canonicalUnit: string;
  colormap: string;
  component: string;
  display: {
    axisUnit: "m";
    legendUnit: string;
    probeScale: number;
  };
  frame: PlanarFrame;
  interaction: { panU: number; panV: number; zoom: number };
  layers: FieldMapRenderLayers;
  mask: Uint8Array | null;
  meshOverlay: ArrayBuffer | null;
  opacity: number;
  range: { max: number; min: number } | null;
  resolution: readonly [number, number];
  sampleIdentity: string;
  scalar: Float32Array | Float64Array;
  vectors: Float32Array | Float64Array | null;
  vectorBudget: number;
  vectorScale: number;
  viewport: readonly [number, number, number, number];
}

export function resolvePlanarViewport(
  bounds: readonly [number, number, number, number],
  interaction: { panU: number; panV: number; zoom: number },
): readonly [number, number, number, number] {
  const zoom = Math.max(1e-12, interaction.zoom);
  const centerU = (bounds[0] + bounds[1]) / 2 + interaction.panU;
  const centerV = (bounds[2] + bounds[3]) / 2 + interaction.panV;
  const halfU = (bounds[1] - bounds[0]) / (2 * zoom);
  const halfV = (bounds[3] - bounds[2]) / (2 * zoom);
  return [centerU - halfU, centerU + halfU, centerV - halfV, centerV + halfV];
}

function isRenderable(mask: number | undefined): boolean {
  return isRenderablePlanarOccupancy(mask);
}

function displayScale(canonicalUnit: string, displayUnit: string): number {
  if (canonicalUnit === displayUnit) return 1;
  if (canonicalUnit === "A/m" && displayUnit === "kA/m") return 1 / 1_000;
  if (canonicalUnit === "T" && displayUnit === "mT") return 1_000;
  return 1;
}

export function resolvePlanarDisplayRange(
  values: ArrayLike<number>,
  mask: ArrayLike<number> | undefined,
  requested: PlanarDisplayRange,
): { max: number; min: number } | null {
  if (requested.mode === "manual") {
    const min = requested.min;
    const max = requested.max;
    if (Number.isFinite(min) && Number.isFinite(max) && max! >= min!) {
      return max === min
        ? { max: max! + 0.5, min: min! - 0.5 }
        : { max: max!, min: min! };
    }
    return null;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    if (!isRenderable(mask?.[index]) || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (requested.mode === "symmetric") {
    const magnitude = Math.max(Math.abs(min), Math.abs(max));
    return magnitude === 0 ? { max: 0.5, min: -0.5 } : { max: magnitude, min: -magnitude };
  }
  return max === min ? { max: max + 0.5, min: min - 0.5 } : { max, min };
}

export function buildFieldMapRenderModel(
  input: FieldMapRenderModelInput,
): FieldMapRenderModel {
  const displayUnit = input.displayUnit || input.canonicalUnit;
  const interaction = input.interaction ?? { panU: 0, panV: 0, zoom: 1 };
  return {
    bounds: input.bounds,
    boundsCenter: [
      (input.bounds[0] + input.bounds[1]) / 2,
      (input.bounds[2] + input.bounds[3]) / 2,
    ],
    canonicalUnit: input.canonicalUnit,
    colormap: input.colormap ?? "viridis",
    component: input.component,
    display: {
      axisUnit: "m",
      legendUnit: displayUnit,
      probeScale: displayScale(input.canonicalUnit, displayUnit),
    },
    frame: input.frame,
    interaction,
    layers: input.layers,
    mask: input.mask ?? null,
    meshOverlay: input.meshOverlay ?? null,
    opacity: Math.max(0, Math.min(1, input.opacity ?? 1)),
    range: resolvePlanarDisplayRange(input.scalar, input.mask ?? undefined, input.range),
    resolution: input.resolution,
    sampleIdentity: input.sampleIdentity,
    scalar: input.scalar,
    vectors: input.vectors ?? null,
    vectorBudget: Math.max(0, Math.floor(input.vectorBudget ?? 2_000)),
    vectorScale: Math.max(0, input.vectorScale ?? 1),
    viewport: resolvePlanarViewport(input.bounds, interaction),
  };
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

export function projectPlanarVectors(
  values: Float32Array | Float64Array,
  frame: PlanarFrame,
): Float64Array {
  const projected = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 3) {
    const components = resolvePlanarVectorComponents(
      [values[index] ?? 0, values[index + 1] ?? 0, values[index + 2] ?? 0],
      frame,
    );
    projected[index] = components.u;
    projected[index + 1] = components.v;
    projected[index + 2] = components.normal;
  }
  return projected;
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

export interface FieldMapAuxiliaryLayerState {
  errorMessage?: string | null;
  hasData: boolean;
  label: string;
  requested: boolean;
  status: "error" | "idle" | "loading" | "ready" | "stale";
}

export function resolveFieldMapAuxiliaryDiagnostics(
  layers: readonly FieldMapAuxiliaryLayerState[],
): string[] {
  return layers.flatMap(({ errorMessage, hasData, label, requested, status }) => {
    if (!requested) return [];
    if (status === "error") {
      return [`${label}: degraded — ${errorMessage ?? "resource unavailable"}.`];
    }
    if (status === "stale") {
      return [`${label}: stale — the last revision is not current.`];
    }
    if (status === "ready" && !hasData) {
      return [`${label}: not materialized for this scope.`];
    }
    return [];
  });
}
