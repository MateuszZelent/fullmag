import { absorbingExpressionError } from "./absorbingExpressionValidation";
import type {
  AbsorbingBoundaryGeometry,
  ObjectPatchRequest,
  SpatialAbsorbingLayer,
} from "@/kernel/api/apiTypes";

export const ABSORBING_BOUNDARY_FACES = ["x+", "x-", "y+", "y-", "z+", "z-"] as const;
export const ABSORBING_BOUNDARY_PROFILES = ["linear", "quadratic", "smootherstep", "logarithmic", "tanh", "custom"] as const;
export const ABSORBING_BOUNDARY_FRAMES = ["object", "universe"] as const;
export type GeometryKind = AbsorbingBoundaryGeometry["kind"];
export type VectorDraft = [string, string, string];

export interface LayerDraft {
  id: string;
  name: string;
  enabled: boolean;
  region: string;
  totalWidth: string;
  rampWidth: string;
  maxDamping: string;
  faces: string[];
  profile: string;
  frame: string;
  expression: string;
  kind: GeometryKind;
  point: VectorDraft;
  orientation: VectorDraft;
  radius: string;
  direction: "outward" | "inward";
  boundaryRegion: string;
  distanceExpression: string;
}

export interface AbsorbingBoundaryDraft {
  enabled: boolean;
  legacy: boolean;
  layers: LayerDraft[];
}

type Issue = { field: keyof LayerDraft; error: string; layerId?: string };

export function createLayerDraft(id: string, name: string): LayerDraft {
  return {
    id, name, enabled: true, region: "", kind: "faces", faces: ["x+"],
    totalWidth: "4e-7", rampWidth: "3e-7", maxDamping: "0.5",
    profile: "smootherstep", frame: "object", expression: "",
    point: ["0", "0", "0"], orientation: ["1", "0", "0"], radius: "5e-7",
    direction: "outward", boundaryRegion: "", distanceExpression: "",
  };
}

type ReadableBoundary = Partial<Pick<SpatialAbsorbingLayer,
  "total_width_m" | "ramp_width_m" | "max_damping" | "frame" | "profile" | "expression">> &
  { faces?: readonly string[]; layers?: SpatialAbsorbingLayer[] };

function layerDraft(config: ReadableBoundary, layer?: SpatialAbsorbingLayer): LayerDraft {
  const geometry = layer?.geometry;
  const draft = createLayerDraft(layer?.layer_id ?? "layer-1", layer?.name ?? "Layer 1");
  draft.enabled = layer?.enabled ?? true;
  draft.region = layer?.region_id ?? "";
  draft.totalWidth = String(config.total_width_m ?? draft.totalWidth);
  draft.rampWidth = String(config.ramp_width_m ?? draft.rampWidth);
  draft.maxDamping = String(config.max_damping ?? draft.maxDamping);
  draft.profile = config.profile ?? draft.profile;
  draft.expression = config.expression ?? "";
  draft.frame = config.frame ?? draft.frame;
  draft.kind = geometry?.kind ?? "faces";
  if (!geometry || geometry.kind === "faces") {
    draft.faces = [...(geometry?.faces ?? config.faces ?? [])];
  } else if (geometry.kind === "region_boundary") {
    draft.boundaryRegion = geometry.region_id;
  } else if (geometry.kind === "expression") {
    draft.distanceExpression = geometry.expression;
  } else {
    const point = geometry.kind === "plane" ? geometry.origin : geometry.center;
    draft.point = [String(point[0]), String(point[1]), String(point[2])];
    if (geometry.kind !== "sphere") {
      const vector = geometry.kind === "plane" ? geometry.normal : geometry.axis;
      draft.orientation = [String(vector[0]), String(vector[1]), String(vector[2])];
    }
    if (geometry.kind !== "plane") {
      draft.radius = String(geometry.radius_m);
      draft.direction = geometry.direction;
    }
  }
  return draft;
}

export function absorbingBoundaryDraftFromObject(object?: { absorbing_boundary?: ReadableBoundary | null } | null): AbsorbingBoundaryDraft {
  const config = object?.absorbing_boundary;
  if (!config) return { enabled: false, legacy: true, layers: [createLayerDraft("layer-1", "Layer 1")] };
  if (config.layers) return { enabled: true, legacy: false, layers: config.layers.map(layer => layerDraft(layer, layer)) };
  return { enabled: true, legacy: true, layers: [layerDraft(config)] };
}

export function absorbingBoundaryDraftKey(draft: AbsorbingBoundaryDraft): string {
  return JSON.stringify({ ...draft, layers: draft.layers.map(layer => ({
    ...layer, expression: layer.profile === "custom" ? layer.expression : "",
  })) });
}

function vector(values: VectorDraft): [number, number, number] | null {
  if (values.some(value => !value.trim() || !Number.isFinite(Number(value)))) return null;
  return [Number(values[0]), Number(values[1]), Number(values[2])];
}

function isOption<T extends string>(value: string, options: readonly T[]): value is T {
  return options.some(option => option === value);
}

function buildGeometry(layer: LayerDraft, regions?: readonly string[]): AbsorbingBoundaryGeometry | Issue {
  switch (layer.kind) {
    case "faces": {
      const faces = layer.faces.filter(face => isOption(face, ABSORBING_BOUNDARY_FACES));
      if (!faces.length || faces.length !== layer.faces.length) return { field: "faces", error: "Select at least one boundary face." };
      return { kind: "faces", faces: [...new Set(faces)] };
    }
    case "region_boundary":
      if (!layer.boundaryRegion || (regions && !regions.includes(layer.boundaryRegion))) {
        return { field: "boundaryRegion", error: "Choose an existing region whose boundary the layer follows." };
      }
      return { kind: layer.kind, region_id: layer.boundaryRegion };
    case "expression": {
      const error = absorbingExpressionError(layer.distanceExpression, "distance");
      if (error) return { field: "distanceExpression", error };
      return { kind: layer.kind, expression: layer.distanceExpression.trim() };
    }
    default: {
      const point = vector(layer.point);
      if (!point) return { field: "point", error: "Enter three finite coordinates in metres." };
      const orientation = vector(layer.orientation);
      if (layer.kind !== "sphere" && (!orientation || orientation.every(v => v === 0))) {
        return { field: "orientation", error: "Enter a finite nonzero direction vector." };
      }
      if (layer.kind === "plane") return { kind: "plane", origin: point, normal: orientation! };
      const radius = Number(layer.radius);
      if (!Number.isFinite(radius) || radius <= 0) return { field: "radius", error: "Radius must be finite and positive." };
      if (layer.direction === "outward" && radius < Number(layer.totalWidth)) {
        return { field: "radius", error: "An outward-rising layer needs a radius at least as large as its total width." };
      }
      const radial = { center: point, radius_m: radius, direction: layer.direction };
      if (layer.kind === "cylinder") return { kind: "cylinder", axis: orientation!, ...radial };
      return { kind: "sphere", ...radial };
    }
  }
}

function buildLayer(layer: LayerDraft, regions?: readonly string[]): SpatialAbsorbingLayer | Issue {
  if (!layer.name.trim()) return { field: "name", error: "Enter a layer name." };
  if (layer.region && regions && !regions.includes(layer.region)) {
    return { field: "region", error: "Choose an existing target region or the whole object." };
  }
  const totalWidth = Number(layer.totalWidth);
  const rampWidth = Number(layer.rampWidth);
  const maxDamping = Number(layer.maxDamping);
  if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
    return { field: "totalWidth", error: "Total width must be a finite positive number." };
  }
  if (!Number.isFinite(rampWidth) || rampWidth <= 0 || rampWidth > totalWidth) {
    return { field: "rampWidth", error: "Ramp width must be positive and no greater than total width." };
  }
  if (!layer.maxDamping.trim() || !Number.isFinite(maxDamping) || maxDamping < 0) {
    return { field: "maxDamping", error: "Maximum damping must be finite and non-negative." };
  }
  if (!isOption(layer.profile, ABSORBING_BOUNDARY_PROFILES)) return { field: "profile", error: "Select a supported damping profile." };
  if (!isOption(layer.frame, ABSORBING_BOUNDARY_FRAMES)) return { field: "frame", error: "Select a supported coordinate frame." };
  if (layer.profile === "custom") {
    const error = absorbingExpressionError(layer.expression, "profile");
    if (error) return { field: "expression", error };
  }
  const geometry = buildGeometry(layer, regions);
  if ("error" in geometry) return geometry;
  return {
    layer_id: layer.id, name: layer.name.trim(), enabled: layer.enabled,
    ...(layer.region && { region_id: layer.region }), geometry,
    total_width_m: totalWidth, ramp_width_m: rampWidth, max_damping: maxDamping,
    profile: layer.profile, frame: layer.frame,
    ...(layer.profile === "custom" && { expression: layer.expression.trim() }),
  };
}

export function buildAbsorbingBoundaryPatch(
  draft: AbsorbingBoundaryDraft, baseRevision: number | null, regions?: readonly string[],
): Issue | { patch: ObjectPatchRequest } {
  if (!draft.enabled) return { patch: { base_revision: baseRevision, absorbing_boundary: null } };
  const layers: SpatialAbsorbingLayer[] = [];
  for (const layer of draft.layers) {
    const result = buildLayer(layer, regions);
    if ("error" in result) return { ...result, layerId: layer.id };
    layers.push(result);
  }
  const first = layers[0];
  if (draft.legacy && first?.geometry.kind === "faces") {
    const { total_width_m, ramp_width_m, max_damping, frame, profile, expression } = first;
    return { patch: { base_revision: baseRevision, absorbing_boundary: {
      total_width_m, ramp_width_m, max_damping, frame, profile,
      ...(expression && { expression }), faces: first.geometry.faces,
    } } };
  }
  return { patch: { base_revision: baseRevision, absorbing_boundary: { layers } } };
}

/** Keep edits made during Apply while accepting the server's canonical numeric formatting. */
export function rebaseAbsorbingBoundaryDraft(
  acknowledged: AbsorbingBoundaryDraft, submitted: AbsorbingBoundaryDraft, latest: AbsorbingBoundaryDraft,
): AbsorbingBoundaryDraft {
  if (latest === submitted) return acknowledged;
  if (!acknowledged.enabled && !submitted.enabled && latest.enabled) return latest;
  const layers = latest.layers.map(layer => {
    const sent = submitted.layers.find(candidate => candidate.id === layer.id);
    const saved = acknowledged.layers.find(candidate => candidate.id === layer.id);
    if (!sent || !saved) return layer;
    const rebased = { ...saved };
    for (const key of Object.keys(layer) as (keyof LayerDraft)[]) {
      if (layer[key] !== sent[key]) Object.assign(rebased, { [key]: layer[key] });
    }
    return rebased;
  });
  return {
    layers, enabled: latest.enabled === submitted.enabled ? acknowledged.enabled : latest.enabled,
    legacy: latest.legacy === submitted.legacy ? acknowledged.legacy : latest.legacy,
  };
}
