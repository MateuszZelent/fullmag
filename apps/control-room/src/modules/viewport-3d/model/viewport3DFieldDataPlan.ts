import type { FieldVectorQuery } from "@/kernel/api/apiTypes";
import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";
import {
  surfaceColorSourceToColorMode,
  type SurfaceColorSource,
  type VisualizationGeometryScope,
  type VisualizationTargetKind,
} from "@/kernel/visualization/ObjectVisualizationController";

export type Viewport3DFieldPayloadCompleteness =
  | "none"
  | "complete"
  | "sampled-ok";

export type Viewport3DFieldComponentDemand =
  | "none"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "full";

export type Viewport3DPassDemandKind =
  | "colorbar"
  | "surface"
  | "vector-glyph";

export type Viewport3DFieldScopeKind =
  | "airbox"
  | "full"
  | "object"
  | "part"
  | "selection";

export interface Viewport3DScalarRangePolicy {
  max: number | null;
  min: number | null;
  mode: "auto" | "manual" | "shared";
  scale: "diverging" | "linear" | "log";
  symmetric: boolean;
}

export interface Viewport3DTargetRenderPlan {
  colorbar: {
    inspectorVisible: boolean;
    viewportVisible: boolean;
  };
  label: string;
  quantityId: string;
  shader: {
    monoColor: string;
    palette: string;
    scalarColorMode: string | null;
    scalarRangePolicy: Viewport3DScalarRangePolicy;
    surfaceColorSource: SurfaceColorSource;
    visible: boolean;
  };
  targetId: string;
  targetKind: VisualizationTargetKind | "fdm-domain";
  vectors: {
    anchorMode: "center" | "tail";
    budget: number;
    colorMode: string;
    lengthScale: number;
    scope: VisualizationGeometryScope;
    surfaceOffsetEnabled: boolean;
    surfaceOffsetScale: number;
    visible: boolean;
  };
  visible: boolean;
}

export interface Viewport3DPassDemand {
  component: Viewport3DFieldComponentDemand;
  completeness: Viewport3DFieldPayloadCompleteness;
  maxSamples: number | null;
  passId: string;
  passKind: Viewport3DPassDemandKind;
  quantityId: string;
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
  targetId: string;
}

export interface Viewport3DFieldResourceRequest {
  consumers: readonly string[];
  query: FieldVectorQuery;
  quantityId: string;
  requestId: string;
}

export interface Viewport3DScalarFieldComponentRequest {
  component: "magnitude" | "x" | "y" | "z" | null;
  needsFullVector: boolean;
}

const VIEWPORT_3D_SCALAR_FIELD_COMPONENTS = new Set([
  "magnitude",
  "x",
  "y",
  "z",
]);

export const DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY: Viewport3DScalarRangePolicy = {
  max: null,
  min: null,
  mode: "auto",
  scale: "linear",
  symmetric: false,
};

export function buildViewport3DTargetRenderPlan({
  label,
  quantityId,
  settings,
  targetId,
  targetKind,
}: {
  label?: string | null;
  quantityId?: string | null;
  settings: {
    geometryScope: VisualizationGeometryScope;
    scalarColorPalette: string;
    shaderMonoColor: string;
    shaderVisible: boolean;
    surfaceColorSource: SurfaceColorSource;
    vectorCenteringEnabled: boolean;
    vectorColorMode: string;
    vectorLengthScale: number;
    vectorSurfaceOffsetEnabled: boolean;
    vectorSurfaceOffsetScale: number;
    vectorBudget: number;
    vectorsVisible: boolean;
    viewportColorbarVisible: boolean;
    visible: boolean;
  };
  targetId: string;
  targetKind: Viewport3DTargetRenderPlan["targetKind"];
}): Viewport3DTargetRenderPlan {
  const visible = settings.visible;
  const scalarColorMode =
    visible && settings.shaderVisible
      ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
      : null;
  const colorbarAvailable = fieldColorModeScalarComponent(scalarColorMode) !== null;
  return {
    colorbar: {
      inspectorVisible: colorbarAvailable,
      viewportVisible:
        visible && settings.viewportColorbarVisible && colorbarAvailable,
    },
    label: label ?? targetId,
    quantityId: resolveCanonicalQuantityId(quantityId ?? "m"),
    shader: {
      monoColor: settings.shaderMonoColor,
      palette: settings.scalarColorPalette,
      scalarColorMode,
      scalarRangePolicy: DEFAULT_VIEWPORT_3D_SCALAR_RANGE_POLICY,
      surfaceColorSource: settings.surfaceColorSource,
      visible: visible && settings.shaderVisible,
    },
    targetId,
    targetKind,
    vectors: {
      anchorMode: settings.vectorCenteringEnabled ? "center" : "tail",
      budget: Math.max(0, Math.floor(settings.vectorBudget)),
      colorMode: settings.vectorColorMode,
      lengthScale: settings.vectorLengthScale,
      scope: settings.geometryScope,
      surfaceOffsetEnabled: settings.vectorSurfaceOffsetEnabled,
      surfaceOffsetScale: settings.vectorSurfaceOffsetScale,
      visible:
        visible &&
        settings.vectorsVisible &&
        Math.max(0, Math.floor(settings.vectorBudget)) > 0,
    },
    visible,
  };
}

export function buildViewport3DPassDemands(
  plan: Viewport3DTargetRenderPlan,
  options: {
    maxSamples?: number | null;
    scopeId?: string | null;
    scopeKind?: Viewport3DFieldScopeKind;
  } = {},
): Viewport3DPassDemand[] {
  if (!plan.visible) return [];
  const scopeKind = options.scopeKind ?? scopeKindForTargetKind(plan.targetKind);
  const scopeId = options.scopeId ?? scopeIdForTarget(plan.targetId, scopeKind);
  const demands: Viewport3DPassDemand[] = [];

  if (plan.shader.visible && plan.shader.scalarColorMode) {
    const query = resolveViewport3DTargetFieldQuery({
      surfaceColorMode: plan.shader.scalarColorMode,
      vectorsVisible: false,
    });
    if (query) {
      demands.push({
        component: query.component === "full"
          ? "full"
          : componentDemandFromQuery(query.component),
        completeness: "complete",
        maxSamples: null,
        passId: `${plan.targetId}:surface`,
        passKind: "surface",
        quantityId: plan.quantityId,
        scopeId,
        scopeKind,
        targetId: plan.targetId,
      });
    }
  }

  if (plan.vectors.visible) {
    demands.push({
      component: "full",
      completeness: plan.shader.visible && plan.shader.scalarColorMode
        ? "complete"
        : "sampled-ok",
      maxSamples:
        plan.shader.visible && plan.shader.scalarColorMode
          ? null
          : Math.max(0, Math.floor(options.maxSamples ?? plan.vectors.budget)),
      passId: `${plan.targetId}:vector-glyph`,
      passKind: "vector-glyph",
      quantityId: plan.quantityId,
      scopeId,
      scopeKind,
      targetId: plan.targetId,
    });
  }

  if (plan.colorbar.viewportVisible && plan.shader.scalarColorMode) {
    demands.push({
      component: componentDemandForColorMode(plan.shader.scalarColorMode),
      completeness: "complete",
      maxSamples: null,
      passId: `${plan.targetId}:colorbar`,
      passKind: "colorbar",
      quantityId: plan.quantityId,
      scopeId,
      scopeKind,
      targetId: plan.targetId,
    });
  }

  return demands;
}

export function planViewport3DFieldResourceRequests(
  demands: readonly Viewport3DPassDemand[],
): Viewport3DFieldResourceRequest[] {
  const requests = new Map<string, {
    consumers: Set<string>;
    demand: Viewport3DPassDemand;
  }>();

  for (const demand of demands) {
    if (demand.component === "none" || demand.completeness === "none") {
      continue;
    }
    const baseKey = fieldDemandBaseKey(demand);
    const current = requests.get(baseKey);
    if (!current) {
      requests.set(baseKey, {
        consumers: new Set([demand.passId]),
        demand,
      });
      continue;
    }
    current.consumers.add(demand.passId);
    current.demand = mergeFieldDemands(current.demand, demand);
  }

  return Array.from(requests.values())
    .map(({ consumers, demand }) => {
      const query = fieldQueryForDemand(demand);
      return {
        consumers: Array.from(consumers).sort(),
        query,
        quantityId: demand.quantityId,
        requestId: buildViewport3DFieldResourceRequestId(
          demand.quantityId,
          query,
        ),
      };
    })
    .sort((left, right) => left.requestId.localeCompare(right.requestId));
}

export function buildViewport3DFieldResourceRequestId(
  quantityId: string,
  query: FieldVectorQuery,
): string {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  const pairs: Array<[string, string]> = [
    ["quantity", canonicalQuantityId],
    ["component", query.component ?? "full"],
    ["scope_kind", query.scope_kind ?? "full"],
  ];
  if (query.scope_id) pairs.push(["scope_id", query.scope_id]);
  if (query.max_samples != null) {
    pairs.push(["max_samples", String(Math.max(0, Math.floor(query.max_samples)))]);
  }
  if (query.snapshot_id) pairs.push(["snapshot_id", query.snapshot_id]);
  if (query.stage_id) pairs.push(["stage_id", query.stage_id]);
  if (query.view) pairs.push(["view", query.view]);
  if (query.phase_rad != null) pairs.push(["phase_rad", String(query.phase_rad)]);
  return pairs
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function resolveViewport3DTargetFieldQuery({
  surfaceColorMode,
  vectorsVisible,
}: {
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery | null {
  if (vectorsVisible) {
    return {
      component: "full",
      scope_kind: "full",
    };
  }
  if (!surfaceColorMode) return null;

  const component = fieldColorModeScalarComponent(surfaceColorMode);
  return component
    ? {
        component,
        scope_kind: "full",
      }
    : {
        component: "full",
        scope_kind: "full",
      };
}

export function resolveViewport3DScopedFieldQuery({
  maxSamples,
  surfaceColorMode,
  vectorsVisible,
}: {
  maxSamples: number;
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery {
  const query = resolveViewport3DTargetFieldQuery({
    surfaceColorMode,
    vectorsVisible,
  }) ?? {
    component: "full",
    scope_kind: "full",
  };
  if (!vectorsVisible || surfaceColorMode) {
    return query;
  }

  const sampleLimit = Math.max(0, Math.floor(maxSamples));
  return sampleLimit > 0
    ? {
        ...query,
        max_samples: sampleLimit,
      }
    : query;
}

export function resolveViewport3DScalarComponentRequest(
  modes: ReadonlySet<string> | null | undefined,
  additionalMode: string | null | undefined,
): Viewport3DScalarFieldComponentRequest {
  let component: Viewport3DScalarFieldComponentRequest["component"] = null;
  for (const mode of scalarFieldRequestModes(modes, additionalMode)) {
    const nextComponent = fieldColorModeScalarComponent(mode);
    if (!nextComponent) {
      return { component: null, needsFullVector: true };
    }
    if (component && component !== nextComponent) {
      return { component: null, needsFullVector: true };
    }
    component = nextComponent;
  }
  return { component, needsFullVector: false };
}

export function mergeViewport3DFieldVectorQueries(
  current: FieldVectorQuery | undefined,
  next: FieldVectorQuery,
): FieldVectorQuery {
  if (!current) return next;
  const replayQuery = {
    snapshot_id: next.snapshot_id ?? current.snapshot_id,
    stage_id: next.stage_id ?? current.stage_id,
    view: next.view ?? current.view,
    phase_rad: next.phase_rad ?? current.phase_rad,
  };
  if (current.component === "full" || next.component === "full") {
    return {
      component: "full",
      scope_kind: "full",
      ...replayQuery,
    };
  }
  return current.component === next.component
    ? { ...current, ...replayQuery }
    : {
        component: "full",
        scope_kind: "full",
        ...replayQuery,
      };
}

function mergeFieldDemands(
  current: Viewport3DPassDemand,
  next: Viewport3DPassDemand,
): Viewport3DPassDemand {
  return {
    ...current,
    component: mergeFieldComponentDemand(current.component, next.component),
    completeness: mergeFieldCompletenessDemand(
      current.completeness,
      next.completeness,
    ),
    maxSamples: mergeMaxSamples(
      current.maxSamples,
      next.maxSamples,
      current.completeness === "complete" || next.completeness === "complete",
    ),
  };
}

function mergeFieldComponentDemand(
  current: Viewport3DFieldComponentDemand,
  next: Viewport3DFieldComponentDemand,
): Viewport3DFieldComponentDemand {
  if (current === "full" || next === "full") return "full";
  if (current === "none") return next;
  if (next === "none") return current;
  return current === next ? current : "full";
}

function mergeFieldCompletenessDemand(
  current: Viewport3DFieldPayloadCompleteness,
  next: Viewport3DFieldPayloadCompleteness,
): Viewport3DFieldPayloadCompleteness {
  if (current === "complete" || next === "complete") return "complete";
  if (current === "sampled-ok" || next === "sampled-ok") return "sampled-ok";
  return "none";
}

function mergeMaxSamples(
  current: number | null,
  next: number | null,
  complete: boolean,
): number | null {
  if (complete) return null;
  if (current == null) return next;
  if (next == null) return current;
  return Math.max(current, next);
}

function fieldQueryForDemand(demand: Viewport3DPassDemand): FieldVectorQuery {
  const query: FieldVectorQuery = {
    component: demand.component === "none" ? "full" : demand.component,
    scope_kind: demand.scopeKind,
  };
  if (demand.scopeId) query.scope_id = demand.scopeId;
  if (demand.completeness === "sampled-ok" && demand.maxSamples != null) {
    const maxSamples = Math.max(0, Math.floor(demand.maxSamples));
    if (maxSamples > 0) query.max_samples = maxSamples;
  }
  return query;
}

function fieldDemandBaseKey(demand: Viewport3DPassDemand): string {
  return [
    resolveCanonicalQuantityId(demand.quantityId),
    demand.scopeKind,
    demand.scopeId ?? "",
  ].join("\u0000");
}

function componentDemandForColorMode(
  mode: string | null | undefined,
): Viewport3DFieldComponentDemand {
  return fieldColorModeScalarComponent(mode) ?? "full";
}

function componentDemandFromQuery(
  component: FieldVectorQuery["component"],
): Viewport3DFieldComponentDemand {
  return component === "x" ||
      component === "y" ||
      component === "z" ||
      component === "magnitude"
    ? component
    : "full";
}

function fieldColorModeScalarComponent(
  mode: string | null | undefined,
): Viewport3DScalarFieldComponentRequest["component"] {
  if (!mode) return null;
  return VIEWPORT_3D_SCALAR_FIELD_COMPONENTS.has(mode)
    ? mode as Viewport3DScalarFieldComponentRequest["component"]
    : null;
}

function* scalarFieldRequestModes(
  modes: ReadonlySet<string> | null | undefined,
  additionalMode: string | null | undefined,
): Generator<string> {
  if (additionalMode) yield additionalMode;
  for (const mode of modes ?? []) {
    yield mode;
  }
}

function scopeKindForTargetKind(
  targetKind: Viewport3DTargetRenderPlan["targetKind"],
): Viewport3DFieldScopeKind {
  if (targetKind === "airbox") return "airbox";
  if (targetKind === "object") return "object";
  if (targetKind === "part") return "part";
  return "full";
}

function scopeIdForTarget(
  targetId: string,
  scopeKind: Viewport3DFieldScopeKind,
): string | null {
  return scopeKind === "full" ? null : targetId;
}
