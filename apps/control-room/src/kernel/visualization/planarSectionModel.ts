import type {
  DomainMetaResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";

export type PlanarSectionPlane = "xy" | "xz" | "yz";
export type PlanarSectionAxis = "x" | "y" | "z";
type DefaultSlice = NonNullable<VisualizationStateResource["planar"]>["default_slice"];
type DefaultOperator = DefaultSlice["operator"];

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const PLANE_AXES: Record<PlanarSectionPlane, {
  normal: PlanarSectionAxis;
  u: PlanarSectionAxis;
  v: PlanarSectionAxis;
}> = {
  xy: { normal: "z", u: "x", v: "y" },
  xz: { normal: "y", u: "x", v: "z" },
  yz: { normal: "x", u: "y", v: "z" },
};

/** Raster limits accepted by the planar data-plane query. */
export const PLANAR_MIN_RESOLUTION = 16;
export const PLANAR_MAX_RESOLUTION = 2048;

/**
 * Factor applied to the domain extent for the "average over the full
 * thickness" slab. The default slice centre may sit anywhere inside the
 * domain (FDM snaps it to a cell centre), so twice the extent always covers
 * the whole domain; empty volume does not enter the occupied-measure mean.
 */
const FULL_THICKNESS_SLAB_FACTOR = 2;

/** Matches the caption tolerance for "shown" vs. "requested" coordinates. */
const STOP_SNAP_RELATIVE_WINDOW = 1e-6;

export interface PlanarSectionGeometry {
  plane: PlanarSectionPlane;
  normal: PlanarSectionAxis;
  u: PlanarSectionAxis;
  v: PlanarSectionAxis;
  normalMin: number;
  normalMax: number;
  normalExtent: number;
  /** FDM cell layers along the normal; null for unstructured domains. */
  layerCount: number | null;
  layerSpacing: number | null;
  /** Native FDM cell counts along u and v; null for unstructured domains. */
  nativeResolution: readonly [number, number] | null;
  /**
   * Discrete node-plane coordinates of a swept FEM mesh along the normal
   * (from the sample metadata section); null when the section is continuous.
   */
  stops?: readonly number[] | null;
  /**
   * Navigation step of a continuous FEM section: the median normal extent of
   * the elements cut by the current plane (`eq-planar-navigation-step`). A
   * navigation aid, not a data layer.
   */
  navigationStepM?: number | null;
}

/** Attach FEM node-plane stops or the continuous navigation step published by the backend section. */
export function withSectionStops(
  geometry: PlanarSectionGeometry | null,
  section: {
    layer_stops_m?: number[] | null;
    navigation_step_kind?: string | null;
    navigation_step_m?: number | null;
    plane: string;
  } | null | undefined,
): PlanarSectionGeometry | null {
  if (!geometry || geometry.layerCount !== null || section?.plane !== geometry.plane) return geometry;
  const stops = section.layer_stops_m ?? [];
  if (stops.length >= 2) return { ...geometry, stops };
  const step = section.navigation_step_m;
  return section.navigation_step_kind === "median_element_height" &&
    typeof step === "number" && Number.isFinite(step) && step > 0
    ? { ...geometry, navigationStepM: step }
    : geometry;
}

/** Number of discrete layers (FDM cells or FEM node planes), or null if continuous. */
export function sectionLayerCount(geometry: PlanarSectionGeometry | null): number | null {
  if (!geometry) return null;
  return geometry.stops?.length ?? geometry.layerCount;
}

/** Discrete layer index for a position fraction (nearest node plane for FEM). */
export function sectionLayerIndex(geometry: PlanarSectionGeometry, fraction: number): number | null {
  if (geometry.stops?.length) {
    const coordinate = geometry.normalMin + clampFraction(fraction) * geometry.normalExtent;
    let best = 0;
    geometry.stops.forEach((stop, index) => {
      if (Math.abs(stop - coordinate) < Math.abs(geometry.stops![best]! - coordinate)) best = index;
    });
    return best;
  }
  return geometry.layerCount !== null ? layerIndexFromFraction(fraction, geometry.layerCount) : null;
}

/**
 * Requested coordinate relative to the FEM node planes. The backend snaps a
 * request to a plane only within a relative window and otherwise samples the
 * requested coordinate between planes (`fem_node_planes_between`).
 */
export function sectionStopPosition(
  geometry: PlanarSectionGeometry,
  fraction: number,
): { coordinate: number; index: number; onStop: boolean } {
  const coordinate = geometry.normalMin + clampFraction(fraction) * geometry.normalExtent;
  const index = sectionLayerIndex(geometry, fraction) ?? 0;
  const stop = geometry.stops?.[index];
  const onStop = stop !== undefined &&
    Math.abs(stop - coordinate) <= STOP_SNAP_RELATIVE_WINDOW * geometry.normalExtent;
  return { coordinate, index, onStop };
}

/** Position fraction that resolves to exactly layer `index`. */
export function sectionLayerFraction(geometry: PlanarSectionGeometry, index: number): number {
  if (geometry.stops?.length) {
    const clamped = Math.min(Math.max(Math.round(index), 0), geometry.stops.length - 1);
    return clampFraction((geometry.stops[clamped]! - geometry.normalMin) / geometry.normalExtent);
  }
  return geometry.layerCount !== null
    ? fractionFromLayerIndex(index, geometry.layerCount)
    : clampFraction(index);
}

export function planarSectionAxes(plane: PlanarSectionPlane) {
  return PLANE_AXES[plane];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

export function resolvePlanarSectionGeometry(
  domain: DomainMetaResource | null | undefined,
  plane: PlanarSectionPlane,
): PlanarSectionGeometry | null {
  if (!domain) return null;
  const { min, max } = domain.bounds;
  if (min.length !== 3 || max.length !== 3) return null;
  const axes = PLANE_AXES[plane];
  const n = AXIS_INDEX[axes.normal];
  const normalMin = min[n];
  const normalMax = max[n];
  if (!Number.isFinite(normalMin) || !Number.isFinite(normalMax) || normalMax <= normalMin) {
    return null;
  }
  const fdm = typeof domain.discretization === "string" &&
    domain.discretization.trim().toLowerCase() === "fdm";
  const grid = fdm ? domain.grid : null;
  const shape = grid?.shape ?? [];
  const spacing = grid?.spacing ?? [];
  const layerCount = grid ? positiveInteger(shape[n]) : null;
  const layerSpacing =
    layerCount !== null && Number.isFinite(spacing[n]) && spacing[n] > 0 ? spacing[n] : null;
  const nativeU = grid ? positiveInteger(shape[AXIS_INDEX[axes.u]]) : null;
  const nativeV = grid ? positiveInteger(shape[AXIS_INDEX[axes.v]]) : null;
  return {
    plane,
    ...axes,
    normalMin,
    normalMax,
    normalExtent: normalMax - normalMin,
    layerCount: layerSpacing === null ? null : layerCount,
    layerSpacing,
    nativeResolution:
      nativeU !== null && nativeV !== null ? [nativeU, nativeV] : null,
  };
}

function clampFraction(fraction: number): number {
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0.5;
}

/** Mirrors the backend FDM snap: `index = ceil(f * N) - 1`, clamped. */
export function layerIndexFromFraction(fraction: number, layerCount: number): number {
  const scaled = clampFraction(fraction) * layerCount;
  const index = scaled <= 0 ? 0 : Math.ceil(scaled) - 1;
  return Math.min(Math.max(index, 0), layerCount - 1);
}

/** Fraction at the centre of a layer; it snaps back to exactly that layer. */
export function fractionFromLayerIndex(index: number, layerCount: number): number {
  const clamped = Math.min(Math.max(Math.round(index), 0), layerCount - 1);
  return (clamped + 0.5) / layerCount;
}

/** Normal coordinate actually sampled by the backend for this fraction. */
export function resolvedSectionCoordinate(
  geometry: PlanarSectionGeometry,
  fraction: number,
): number {
  if (geometry.stops?.length) {
    const position = sectionStopPosition(geometry, fraction);
    return position.onStop ? geometry.stops[position.index]! : position.coordinate;
  }
  if (geometry.layerCount !== null && geometry.layerSpacing !== null) {
    const index = layerIndexFromFraction(fraction, geometry.layerCount);
    return geometry.normalMin + (index + 0.5) * geometry.layerSpacing;
  }
  return geometry.normalMin + clampFraction(fraction) * geometry.normalExtent;
}

export function fullThicknessSlabOperator(
  geometry: PlanarSectionGeometry,
): Extract<DefaultOperator, { kind: "slab_average" }> {
  return {
    kind: "slab_average",
    thickness_m: FULL_THICKNESS_SLAB_FACTOR * geometry.normalExtent,
  };
}

/** True when the slab covers the whole domain along the normal. */
export function isFullThicknessOperator(
  operator: DefaultOperator,
  geometry: PlanarSectionGeometry | null,
): boolean {
  if (operator.kind !== "slab_average" || !geometry) return false;
  return operator.thickness_m >= FULL_THICKNESS_SLAB_FACTOR * geometry.normalExtent * (1 - 1e-9);
}

export type PlanarSectionReduction = "single" | "average";

export function sectionReduction(
  operator: DefaultOperator,
  geometry: PlanarSectionGeometry | null,
): PlanarSectionReduction {
  return isFullThicknessOperator(operator, geometry) ? "average" : "single";
}

function clampResolution(value: number): number {
  return Math.min(PLANAR_MAX_RESOLUTION, Math.max(PLANAR_MIN_RESOLUTION, Math.round(value)));
}

/** Native FDM raster (one pixel per cell) within the accepted query limits. */
export function nativePlanarResolution(
  geometry: PlanarSectionGeometry | null,
): readonly [number, number] | null {
  const native = geometry?.nativeResolution;
  return native ? [clampResolution(native[0]), clampResolution(native[1])] : null;
}

export interface PlanarResolutionPreset {
  label: string;
  width: number;
  height: number;
}

/**
 * FDM raster presets: the native grid and its integer reductions. When the
 * factor divides the cell counts every pixel covers whole cells, so the area
 * average is exact; sizes are clamped to the accepted query limits.
 */
export function planarGridResolutionPresets(
  geometry: PlanarSectionGeometry | null,
): PlanarResolutionPreset[] {
  const native = geometry?.nativeResolution;
  if (!native) return [];
  const presets: PlanarResolutionPreset[] = [];
  for (const factor of [1, 2, 4, 8, 16, 32]) {
    if (factor > 1 && native[0] / factor < PLANAR_MIN_RESOLUTION) break;
    const width = clampResolution(native[0] / factor);
    const height = clampResolution(native[1] / factor);
    if (presets.some((preset) => preset.width === width && preset.height === height)) continue;
    presets.push({
      label: factor === 1 ? `Native grid (${width} × ${height})` : `1/${factor} grid (${width} × ${height})`,
      width,
      height,
    });
  }
  return presets;
}

export function formatSectionLength(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  const nm = meters * 1e9;
  const abs = Math.abs(nm);
  if (abs >= 1000) return `${(nm / 1000).toFixed(abs >= 10000 ? 1 : 2)} µm`;
  if (abs >= 100) return `${nm.toFixed(0)} nm`;
  if (abs >= 10) return `${nm.toFixed(1)} nm`;
  return `${nm.toFixed(2)} nm`;
}

/** Fraction step used for continuous (unstructured) sections: 1 % of the extent. */
const CONTINUOUS_SECTION_STEP = 0.01;

/**
 * Move the default slice by `delta` layers (FDM) or `delta` navigation steps
 * (continuous sections). The result always lands on a layer centre when the
 * section has discrete layers, so it snaps back to exactly that layer.
 */
export function stepSectionFraction(
  fraction: number,
  geometry: PlanarSectionGeometry | null,
  delta: number,
): number {
  const steps = Math.round(delta);
  if (geometry?.stops?.length) {
    const position = sectionStopPosition(geometry, fraction);
    if (position.onStop || steps === 0) {
      return sectionLayerFraction(geometry, position.index + steps);
    }
    // Between node planes: the first step lands on the adjacent plane in the
    // direction of travel, so no plane is skipped.
    const stops = geometry.stops;
    const adjacent = steps > 0
      ? stops.findIndex((stop) => stop > position.coordinate)
      : stops.findLastIndex((stop) => stop < position.coordinate);
    if (adjacent < 0) return clampFraction(fraction);
    return sectionLayerFraction(geometry, adjacent + steps - Math.sign(steps));
  }
  const count = sectionLayerCount(geometry);
  if (geometry && count !== null) {
    const index = sectionLayerIndex(geometry, fraction) ?? 0;
    return sectionLayerFraction(geometry, index + steps);
  }
  const step = geometry?.navigationStepM && geometry.normalExtent > 0
    ? geometry.navigationStepM / geometry.normalExtent
    : CONTINUOUS_SECTION_STEP;
  return clampFraction(clampFraction(fraction) + delta * step);
}

/** Extent of one realized object along the section normal (a named layer). */
export interface ObjectSectionLayer {
  objectId: string;
  name: string;
  min: number;
  max: number;
}

interface RealizedBodyBounds {
  bounds_max: number[];
  bounds_min: number[];
  object_id: string;
  object_name: string;
}

/**
 * Named layers along `axis` from the realized geometry bodies, merged per
 * object and ordered along the normal (note 0970, object layers).
 */
export function objectSectionLayers(
  bodies: readonly RealizedBodyBounds[] | null | undefined,
  axis: PlanarSectionAxis,
): ObjectSectionLayer[] {
  const index = AXIS_INDEX[axis];
  const layers = new Map<string, ObjectSectionLayer>();
  for (const body of bodies ?? []) {
    const min = body.bounds_min[index];
    const max = body.bounds_max[index];
    if (typeof min !== "number" || typeof max !== "number" ||
      !Number.isFinite(min) || !Number.isFinite(max) || max <= min) continue;
    const previous = layers.get(body.object_id);
    layers.set(body.object_id, previous
      ? { ...previous, max: Math.max(previous.max, max), min: Math.min(previous.min, min) }
      : { max, min, name: body.object_name || body.object_id, objectId: body.object_id });
  }
  return [...layers.values()].sort((left, right) => left.min - right.min || left.max - right.max);
}

/** Default slice of a named layer: a slab of the object's thickness centred on it. */
export function objectLayerSlice(
  geometry: PlanarSectionGeometry,
  layer: ObjectSectionLayer,
): { operator: Extract<DefaultOperator, { kind: "slab_average" }>; position_fraction: number } {
  return {
    operator: { kind: "slab_average", thickness_m: layer.max - layer.min },
    position_fraction: clampFraction(((layer.min + layer.max) / 2 - geometry.normalMin) / geometry.normalExtent),
  };
}

/** The named layer the current default slice selects, if any. */
export function matchObjectLayer(
  slice: { operator: DefaultOperator; position_fraction: number },
  geometry: PlanarSectionGeometry | null,
  layers: readonly ObjectSectionLayer[],
): ObjectSectionLayer | null {
  if (!geometry || slice.operator.kind !== "slab_average") return null;
  const tolerance = STOP_SNAP_RELATIVE_WINDOW * geometry.normalExtent;
  const thickness = slice.operator.thickness_m;
  const centre = geometry.normalMin + clampFraction(slice.position_fraction) * geometry.normalExtent;
  return layers.find((layer) =>
    Math.abs(layer.max - layer.min - thickness) <= tolerance &&
    Math.abs((layer.min + layer.max) / 2 - centre) <= tolerance) ?? null;
}
