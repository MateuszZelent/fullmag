import { resolveDisplayUnitConversion } from "@/shared/domain/physics/displayUnits";

import { isRenderablePlanarOccupancy } from "./planarOccupancy";

export interface PlanarFrame {
  normal: readonly [number, number, number];
  origin: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
}

export interface FieldMapRenderLayers {
  boundaries?: boolean;
  bounds?: boolean;
  contours: boolean;
  mesh: boolean;
  points?: boolean;
  probes?: boolean;
  raster: boolean;
  vectors: boolean;
}

export interface PlanarDisplayRange {
  mode: "auto" | "manual" | "symmetric";
  max?: number;
  min?: number;
}

export function normalizePlanarColorRange(range: {
  max?: number | null;
  min?: number | null;
  mode: string;
} | null | undefined): PlanarDisplayRange | null {
  if (range === undefined) return { mode: "auto" };
  if (range === null) return null;
  if (range.mode === "auto" || range.mode === "symmetric") return { mode: range.mode };
  if (
    range.mode === "manual" &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.max! >= range.min!
  ) {
    return { mode: "manual", max: range.max!, min: range.min! };
  }
  return null;
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
  meshOverlayDescriptor?: {
    available: boolean;
    boundaryClassification: string;
    codec?: string | null;
    geometrySource?: string | null;
  };
  meshOverlay?: ArrayBuffer | null;
  range: PlanarDisplayRange | null;
  rasterOpacity?: number;
  resolution: readonly [number, number];
  sampleIdentity: string;
  scalar: Float32Array | Float64Array;
  vectors?: Float32Array | Float64Array | null;
  vectorBudget?: number;
  vectorScale?: number;
  vectorStyle?: { color: string; colorMode: string; lengthMode: string; opacity: number; thickness: number };
  wireframeStyle?: { color: string; opacity: number };
  pointStyle?: { color: string; opacity: number; size: number };
  visible?: boolean;
}

export interface FieldMapRenderModel {
  bounds: readonly [number, number, number, number];
  boundsCenter: readonly [number, number];
  boundsOutline: readonly [number, number, number, number] | null;
  canonicalUnit: string;
  colormap: string;
  component: string;
  diagnostics: readonly string[];
  display: {
    axisUnit: "m";
    legendUnit: string;
    probeScale: number;
  };
  frame: PlanarFrame;
  interaction: { panU: number; panV: number; zoom: number };
  layers: FieldMapRenderLayers;
  mask: Uint8Array | null;
  meshOverlayDescriptor: FieldMapRenderModelInput["meshOverlayDescriptor"];
  meshOverlay: ArrayBuffer | null;
  rasterOpacity: number | null;
  range: { max: number; min: number } | null;
  resolution: readonly [number, number];
  sampleIdentity: string;
  samplePoints: readonly PlanarSamplePoint[];
  scalar: Float32Array | Float64Array;
  vectors: Float32Array | Float64Array | null;
  vectorBudget: number;
  vectorScale: number;
  vectorStyle: { color: string; colorMode: string; lengthMode: string; opacity: number; thickness: number };
  wireframeStyle: { color: string; opacity: number };
  pointStyle: { color: string; opacity: number; size: number };
  viewport: readonly [number, number, number, number];
}

export interface PlanarSamplePoint {
  index: number;
  u: number;
  v: number;
}

export function buildPlanarSamplePoints(
  bounds: readonly [number, number, number, number],
  resolution: readonly [number, number],
  mask: ArrayLike<number>,
  maxPoints = 4_096,
): PlanarSamplePoint[] {
  const width = Math.max(0, Math.floor(resolution[0]));
  const height = Math.max(0, Math.floor(resolution[1]));
  const sampleCount = Math.min(mask.length, width * height);
  const budget = Math.max(0, Math.floor(maxPoints));
  if (width === 0 || height === 0 || sampleCount === 0 || budget === 0) return [];
  const candidates: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    if (isRenderable(mask[index])) candidates.push(index);
  }
  const stride = Math.max(1, Math.ceil(candidates.length / budget));
  const deltaU = (bounds[1] - bounds[0]) / width;
  const deltaV = (bounds[3] - bounds[2]) / height;
  const points: PlanarSamplePoint[] = [];
  for (let candidate = 0; candidate < candidates.length && points.length < budget; candidate += stride) {
    const index = candidates[candidate]!;
    const column = index % width;
    const row = Math.floor(index / width);
    points.push({
      index,
      u: bounds[0] + (column + 0.5) * deltaU,
      v: bounds[2] + (row + 0.5) * deltaV,
    });
  }
  return points;
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

export function resolvePlanarDisplayUnit(canonicalUnit: string, requested: string): {
  compatible: boolean;
  scale: number;
  unit: string;
} {
  const resolved = resolveDisplayUnitConversion(canonicalUnit, requested);
  return { compatible: resolved.compatible, scale: resolved.factor, unit: resolved.unit };
}

export function resolvePlanarDisplayRange(
  values: ArrayLike<number>,
  mask: ArrayLike<number> | undefined,
  requested: PlanarDisplayRange,
): { max: number; min: number } | null {
  if (requested.mode === "manual") {
    const min = requested.min;
    const max = requested.max;
    if (Number.isFinite(min) && Number.isFinite(max) && max! > min!) {
      return { max: max!, min: min! };
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
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  if (requested.mode === "symmetric") {
    const magnitude = Math.max(Math.abs(min), Math.abs(max));
    return magnitude === 0 ? { max: 0, min: 0 } : { max: magnitude, min: -magnitude };
  }
  return { max, min };
}

export function buildFieldMapRenderModel(
  input: FieldMapRenderModelInput,
): FieldMapRenderModel {
  const requestedDisplayUnit = input.displayUnit || input.canonicalUnit;
  const displayUnit = resolvePlanarDisplayUnit(input.canonicalUnit, requestedDisplayUnit);
  const interaction = input.interaction ?? { panU: 0, panV: 0, zoom: 1 };
  const diagnostics: string[] = [];
  if (!input.frame.origin.every(Number.isFinite)) {
    diagnostics.push("Planar frame origin is non-finite; axes and probes use local primed coordinates.");
  }
  if (!displayUnit.compatible) {
    diagnostics.push(`Display unit '${requestedDisplayUnit}' is incompatible with canonical unit '${input.canonicalUnit}'.`);
  }
  const boundariesExact = input.meshOverlayDescriptor?.available === true &&
    input.meshOverlayDescriptor.boundaryClassification === "exact" &&
    input.meshOverlayDescriptor.codec === "fmcs.v4";
  if (input.layers.boundaries && !boundariesExact) {
    diagnostics.push(input.meshOverlayDescriptor?.codec === "fmfg.v1"
      ? "2D target boundaries are unavailable for an FDM structured-grid overlay."
      : input.meshOverlayDescriptor?.codec === "fmcs.v3"
      ? "2D boundaries are unavailable: FMCS v3 has no exact target-boundary classes."
      : "2D boundaries are unavailable: mesh overlay classification is unavailable or degraded.");
  }
  const range = input.range
    ? resolvePlanarDisplayRange(input.scalar, input.mask ?? undefined, input.range)
    : null;
  if (!input.range || range === null) diagnostics.push("Planar color range is invalid and was not rendered.");
  const rasterOpacity = input.rasterOpacity ?? 1;
  const rasterOpacityValid = Number.isFinite(rasterOpacity) && rasterOpacity >= 0 && rasterOpacity <= 1;
  if (!rasterOpacityValid) diagnostics.push("Planar raster opacity is invalid and was not rendered.");
  const samplePoints = input.layers.points && input.mask
    ? buildPlanarSamplePoints(input.bounds, input.resolution, input.mask)
    : [];
  if (input.layers.points && !input.mask) {
    diagnostics.push("2D sample points are unavailable: occupancy mask is not materialized.");
  }
  return {
    bounds: input.bounds,
    boundsCenter: [
      (input.bounds[0] + input.bounds[1]) / 2,
      (input.bounds[2] + input.bounds[3]) / 2,
    ],
    boundsOutline: input.layers.bounds ? input.bounds : null,
    canonicalUnit: input.canonicalUnit,
    colormap: input.colormap ?? "viridis",
    component: input.component,
    diagnostics,
    display: {
      axisUnit: "m",
      legendUnit: displayUnit.unit,
      probeScale: displayUnit.scale,
    },
    frame: input.frame,
    interaction,
    layers: {
      raster: Boolean(input.visible !== false && input.layers.raster && rasterOpacityValid && range !== null),
      probes: Boolean(input.visible !== false && (input.layers.probes ?? true)),
      mesh: Boolean(input.visible !== false && input.layers.mesh),
      boundaries: Boolean(input.visible !== false && input.layers.boundaries && boundariesExact),
      bounds: Boolean(input.visible !== false && input.layers.bounds),
      contours: Boolean(input.visible !== false && input.layers.contours),
      points: Boolean(input.visible !== false && input.layers.points),
      vectors: Boolean(input.visible !== false && input.layers.vectors),
    },
    mask: input.mask ?? null,
    meshOverlayDescriptor: input.meshOverlayDescriptor,
    meshOverlay: input.meshOverlay ?? null,
    rasterOpacity: rasterOpacityValid ? rasterOpacity : null,
    range,
    resolution: input.resolution,
    sampleIdentity: input.sampleIdentity,
    samplePoints,
    scalar: input.scalar,
    vectors: input.vectors ?? null,
    vectorBudget: Math.max(0, Math.floor(input.vectorBudget ?? 2_000)),
    vectorScale: Math.max(0, input.vectorScale ?? 1),
    vectorStyle: input.vectorStyle ?? { color: "currentColor", colorMode: "orientation", lengthMode: "uniform", opacity: 1, thickness: 1 },
    wireframeStyle: input.wireframeStyle ?? { color: "currentColor", opacity: 1 },
    pointStyle: input.pointStyle ?? { color: "var(--fm-accent)", opacity: 1, size: 3 },
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
