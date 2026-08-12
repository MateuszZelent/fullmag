import type { FieldCatalogResource, FieldVectorQuery } from "@/kernel/api/apiTypes";
import {
  fieldCatalogQuantitySupportsAirbox,
  isScalarSpatialQuantityId,
  resolveCanonicalQuantityId,
} from "@/kernel/api/quantityIds";
import {
  surfaceColorSourceToColorMode,
  type SurfaceFieldProjectionMode,
  type SurfaceColorSource,
  type VisualizationGeometryScope,
  type VisualizationTargetKind,
  type VisualizationTargetSettings,
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

export const DEFAULT_VIEWPORT3D_SHADER_MONO_COLOR =
  "var(--fm-syntax-string)";

export type Viewport3DFieldScopeKind =
  | "airbox"
  | "full"
  | "layer"
  | "object"
  | "part"
  | "region"
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
    scalarColorMode: string | null;
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
    projectionMode: SurfaceFieldProjectionMode;
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
  replayQuery: Viewport3DReplayFieldQuery | null;
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

export interface Viewport3DFieldDemandDiagnosticSummary {
  demands: readonly string[];
  requests: readonly string[];
  targetId: string;
}

export interface Viewport3DPrimaryFieldRenderOptionsForPlanning {
  fullVectorBudget?: number | null;
  partVectorBudgets?: ReadonlyMap<string, number> | null;
  scalarColorModes?: ReadonlySet<string> | null;
  scalarColorsVisible?: boolean | null;
}

export interface Viewport3DPrimaryFieldQueryOptions {
  fdmInstanceModelNeedsFieldVector: boolean;
  fdmSurfaceColorMode: string | null;
  fdmTopographyEnabled: boolean;
  fdmVectorsVisible: boolean;
  fieldRenderOptions: Viewport3DPrimaryFieldRenderOptionsForPlanning;
}

export interface Viewport3DPrimaryFieldDemandPlan {
  demands: readonly Viewport3DPassDemand[];
  request: Viewport3DFieldResourceRequest;
}

export interface Viewport3DScopedPartFieldSettingsForPlanning {
  activeQuantityId: string;
  shaderVisible: boolean;
  surfaceColorSource: SurfaceColorSource;
  surfaceProjectionMode: SurfaceFieldProjectionMode;
  vectorBudget: number;
  vectorsVisible: boolean;
  visible: boolean;
}

export interface Viewport3DPlanMeshPart {
  id: string;
  label?: string | null;
}

export interface Viewport3DPlanPartModel {
  part: Viewport3DPlanMeshPart;
}

export interface Viewport3DTargetQuantityFieldRequestsOptions {
  availableQuantityIds?: ReadonlySet<string> | null;
  fieldCatalog?: FieldCatalogResource | null;
  fdmAirboxSettings?: VisualizationTargetSettings | null;
  fdmSettings: VisualizationTargetSettings | null;
  fdmTargetSettings?: readonly Viewport3DFdmTargetSettingsForPlanning[];
  getPartSettings: (part: Viewport3DPlanMeshPart) => VisualizationTargetSettings;
  magneticPartScopedFieldIds: ReadonlySet<string>;
  magneticParts: readonly Viewport3DPlanPartModel[];
  maxVectorGlyphs: number;
  primaryFieldQuantityId: string;
  selectedSnapshotQuery?: FieldVectorQuery | null;
}

export interface Viewport3DFdmTargetSettingsForPlanning {
  label: string;
  settings: VisualizationTargetSettings;
  targetId: string;
}

export interface Viewport3DFdmNativeLayerFieldRequestInput {
  layerId: string;
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "shaderVisible" | "vectorsVisible" | "visible"
  > | null;
}

export interface Viewport3DTargetQuantityFieldDemandPlan {
  demands: readonly Viewport3DPassDemand[];
  requests: ReadonlyMap<string, Viewport3DFieldResourceRequest>;
}

export function resolveViewport3DFdmNativeLayerFieldRequests({
  available,
  layers,
  maxSamples,
}: {
  available: boolean;
  layers: readonly Viewport3DFdmNativeLayerFieldRequestInput[];
  maxSamples: number;
}): ReadonlyMap<string, Viewport3DFieldResourceRequest> {
  const requests = new Map<string, Viewport3DFieldResourceRequest>();
  if (!available) return requests;
  for (const { layerId, settings } of layers) {
    if (
      !settings?.visible ||
      (!settings.shaderVisible && !settings.vectorsVisible)
    ) {
      continue;
    }
    const quantityId = resolveCanonicalQuantityId(settings.activeQuantityId);
    requests.set(layerId, {
      consumers: [`viewport-3d:fdm-native-layer:${layerId}`],
      quantityId,
      query: {
        component: "full",
        max_samples: maxSamples,
        scope_id: layerId,
        scope_kind: "layer",
      },
      requestId: `fdm-native-layer:${layerId}:${quantityId}`,
    });
  }
  return requests;
}

export interface Viewport3DScopedPartFieldDemandPlan {
  demands: readonly Viewport3DPassDemand[];
  request: Viewport3DFieldResourceRequest | null;
}

export interface Viewport3DScopedPartVectorFieldDemandPlan {
  demands: readonly Viewport3DPassDemand[];
  requests: ReadonlyMap<string, Viewport3DFieldResourceRequest>;
}

export interface Viewport3DAirboxFieldVectorDemandPlan {
  demands: readonly Viewport3DPassDemand[];
  requests: ReadonlyMap<string, Viewport3DFieldResourceRequest>;
}

export interface Viewport3DScalarFieldComponentRequest {
  component: "magnitude" | "x" | "y" | "z" | null;
  needsFullVector: boolean;
}

export type Viewport3DReplayFieldQuery = Pick<
  FieldVectorQuery,
  "phase_rad" | "snapshot_id" | "stage_id" | "view"
>;

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
    surfaceProjectionMode: SurfaceFieldProjectionMode;
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
  const vectorScalarColorMode =
    visible && settings.vectorsVisible
      ? settings.vectorColorMode
      : null;
  const colorbarScalarColorMode =
    fieldColorModeScalarComponent(scalarColorMode) !== null
      ? scalarColorMode
      : fieldColorModeScalarComponent(vectorScalarColorMode) !== null
        ? vectorScalarColorMode
        : null;
  const colorbarAvailable = colorbarScalarColorMode !== null;
  return {
    colorbar: {
      inspectorVisible: colorbarAvailable,
      scalarColorMode: colorbarScalarColorMode,
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
      projectionMode: settings.surfaceProjectionMode,
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
    forceComplete?: boolean;
    maxSamples?: number | null;
    replayQuery?: Viewport3DReplayFieldQuery | null;
    scopeId?: string | null;
    scopeKind?: Viewport3DFieldScopeKind;
  } = {},
): Viewport3DPassDemand[] {
  if (!plan.visible) return [];
  const scopeKind = options.scopeKind ?? scopeKindForTargetKind(plan.targetKind);
  const scopeId =
    options.scopeId === undefined
      ? scopeIdForTarget(plan.targetId, scopeKind)
      : options.scopeId;
  const demands: Viewport3DPassDemand[] = [];

  if (plan.shader.visible && plan.shader.scalarColorMode) {
    const query = resolveViewport3DTargetFieldQuery({
      quantityId: plan.quantityId,
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
        replayQuery: normalizeReplayFieldQuery(options.replayQuery),
        scopeId,
        scopeKind,
        targetId: plan.targetId,
      });
    }
  }

  if (plan.vectors.visible) {
    const forceComplete = options.forceComplete === true;
    demands.push({
      component: "full",
      completeness: forceComplete || (plan.shader.visible && plan.shader.scalarColorMode)
        ? "complete"
        : "sampled-ok",
      maxSamples:
        forceComplete || (plan.shader.visible && plan.shader.scalarColorMode)
          ? null
          : Math.max(0, Math.floor(options.maxSamples ?? plan.vectors.budget)),
      passId: `${plan.targetId}:vector-glyph`,
      passKind: "vector-glyph",
      quantityId: plan.quantityId,
      replayQuery: normalizeReplayFieldQuery(options.replayQuery),
      scopeId,
      scopeKind,
      targetId: plan.targetId,
    });
  }

  if (plan.colorbar.viewportVisible && plan.colorbar.scalarColorMode) {
    demands.push({
      component: componentDemandForColorMode(plan.colorbar.scalarColorMode),
      completeness: "complete",
      maxSamples: null,
      passId: `${plan.targetId}:colorbar`,
      passKind: "colorbar",
      quantityId: plan.quantityId,
      replayQuery: normalizeReplayFieldQuery(options.replayQuery),
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

export function summarizeViewport3DFieldDemandDiagnostics({
  demands,
  requests,
}: {
  demands: readonly Viewport3DPassDemand[];
  requests: readonly Viewport3DFieldResourceRequest[];
}): Viewport3DFieldDemandDiagnosticSummary[] {
  const summaries = new Map<string, {
    demands: string[];
    requestKeys: Set<string>;
    requests: string[];
  }>();
  const passTargetIds = new Map<string, string>();

  for (const demand of demands) {
    const summary = targetFieldDemandDiagnosticSummary(
      summaries,
      demand.targetId,
    );
    summary.demands.push(summarizeViewport3DPassDemand(demand));
    passTargetIds.set(demand.passId, demand.targetId);
  }

  for (const request of requests) {
    for (const consumer of request.consumers) {
      const targetId = passTargetIds.get(consumer);
      if (!targetId) continue;
      const summary = targetFieldDemandDiagnosticSummary(summaries, targetId);
      if (summary.requestKeys.has(request.requestId)) continue;
      summary.requestKeys.add(request.requestId);
      summary.requests.push(summarizeViewport3DFieldResourceRequest(request));
    }
  }

  return Array.from(summaries, ([targetId, summary]) => ({
    demands: summary.demands.sort(),
    requests: summary.requests.sort(),
    targetId,
  })).sort((left, right) => left.targetId.localeCompare(right.targetId));
}

export function resolveViewport3DPrimaryFieldQuery({
  fdmInstanceModelNeedsFieldVector,
  fdmSurfaceColorMode,
  fdmTopographyEnabled,
  fdmVectorsVisible,
  fieldRenderOptions,
  snapshotQuery,
  snapshotId,
}: Viewport3DPrimaryFieldQueryOptions & {
  snapshotId?: string | null;
  snapshotQuery?: FieldVectorQuery | null;
}): FieldVectorQuery {
  const snapshotParams = snapshotQuery ?? (snapshotId ? { snapshot_id: snapshotId } : {});
  const scalarFieldComponentRequest = resolveViewport3DScalarComponentRequest(
    fieldRenderOptions.scalarColorsVisible === false
      ? null
      : fieldRenderOptions.scalarColorModes,
    fdmSurfaceColorMode,
  );
  if (
    fdmVectorsVisible ||
    fdmTopographyEnabled ||
    viewport3DFieldRenderOptionsNeedFullVectorData(fieldRenderOptions) ||
    scalarFieldComponentRequest.needsFullVector
  ) {
    return {
      component: "full",
      scope_kind: "full",
      ...snapshotParams,
    };
  }

  const component =
    scalarFieldComponentRequest.component ??
    (fdmInstanceModelNeedsFieldVector ? "magnitude" : null);

  return component
    ? {
        component,
        scope_kind: "full",
        ...snapshotParams,
      }
    : {
        component: "full",
        scope_kind: "full",
        ...snapshotParams,
      };
}

export function resolveViewport3DPrimaryFieldDemandPlan({
  primaryFieldQuantityId,
  ...options
}: Viewport3DPrimaryFieldQueryOptions & {
  primaryFieldQuantityId: string;
  snapshotId?: string | null;
  snapshotQuery?: FieldVectorQuery | null;
}): Viewport3DPrimaryFieldDemandPlan {
  const demands = resolveViewport3DPrimaryFieldPassDemands({
    ...options,
    primaryFieldQuantityId,
  });
  const plannedRequest = planViewport3DFieldResourceRequests(demands)[0] ?? null;
  if (plannedRequest) {
    return {
      demands,
      request: {
        ...plannedRequest,
        quantityId: primaryFieldQuantityId,
        requestId: buildViewport3DFieldResourceRequestId(
          primaryFieldQuantityId,
          plannedRequest.query,
        ),
      },
    };
  }

  const query = resolveViewport3DPrimaryFieldQuery(options);
  return {
    demands,
    request: {
      consumers: ["primary-field-vector"],
      quantityId: primaryFieldQuantityId,
      query,
      requestId: buildViewport3DFieldResourceRequestId(
        primaryFieldQuantityId,
        query,
      ),
    },
  };
}

export function resolveViewport3DAirboxFieldVectorDemandPlan({
  airboxParts,
  availableQuantityIds,
  fieldCatalog,
  fieldQuery = { component: "full", scope_kind: "full" },
  quantityId,
  replayQuery = null,
  vectorBudget = fieldQuery.max_samples ?? 0,
  vectorsVisible = Boolean(fieldQuery.max_samples != null),
}: {
  airboxParts: readonly { id: string; label?: string | null }[];
  availableQuantityIds?: ReadonlySet<string> | null;
  fieldCatalog?: FieldCatalogResource | null;
  fieldQuery?: FieldVectorQuery;
  quantityId: string;
  replayQuery?: FieldVectorQuery | null;
  shaderVisible?: boolean;
  surfaceColorSource?: SurfaceColorSource;
  vectorBudget?: number;
  vectorsVisible?: boolean;
}): Viewport3DAirboxFieldVectorDemandPlan {
  if (
    (fieldCatalog &&
      !fieldCatalogQuantitySupportsAirbox(fieldCatalog, quantityId)) ||
    !isViewport3DQuantityAvailable(quantityId, availableQuantityIds)
  ) {
    return {
      demands: [],
      requests: new Map(),
    };
  }

  const demands: Viewport3DPassDemand[] = [];
  const requests = new Map<string, Viewport3DFieldResourceRequest>();
  for (const part of airboxParts) {
    const plan = buildViewport3DTargetRenderPlan({
      label: "Airbox",
      quantityId,
      settings: {
        geometryScope: "full",
        scalarColorPalette: "viridis",
        shaderMonoColor: DEFAULT_VIEWPORT3D_SHADER_MONO_COLOR,
        shaderVisible: false,
        surfaceColorSource: "solid",
        surfaceProjectionMode: "raw_nodal",
        vectorBudget,
        vectorCenteringEnabled: true,
        vectorColorMode: "orientation",
        vectorLengthScale: 1,
        vectorSurfaceOffsetEnabled: false,
        vectorSurfaceOffsetScale: 0,
        vectorsVisible,
        viewportColorbarVisible: false,
        visible: true,
      },
      targetId: part.id,
      targetKind: "airbox",
    });
    const partDemands = buildViewport3DPassDemands(plan, {
      maxSamples: vectorBudget,
      replayQuery,
      scopeId: part.id,
      scopeKind: "airbox",
    });
    demands.push(...partDemands);
    if (partDemands.length === 0) continue;
    const [plannedRequest] = planViewport3DFieldResourceRequests(partDemands);
    const plannedQuery = plannedRequest?.query ?? {
      ...fieldQuery,
      component: fieldQuery.component ?? "full",
      scope_id: part.id,
      scope_kind: "airbox" as const,
    };
    const query = fieldQuery.geometry_scope
      ? { ...plannedQuery, geometry_scope: fieldQuery.geometry_scope }
      : plannedQuery;
    requests.set(part.id, {
      consumers: plannedRequest?.consumers ?? [],
      quantityId: resolveCanonicalQuantityId(quantityId),
      query,
      requestId:
        plannedRequest?.requestId ??
        buildViewport3DFieldResourceRequestId(quantityId, query),
    });
  }

  return {
    demands,
    requests: new Map(
      Array.from(requests).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function isViewport3DQuantityAvailable(
  quantityId: string,
  availableQuantityIds: ReadonlySet<string> | null | undefined,
): boolean {
  return (
    availableQuantityIds == null ||
    availableQuantityIds.has(resolveCanonicalQuantityId(quantityId))
  );
}

export function resolveViewport3DScopedPartVectorFieldDemandPlan({
  getPartSettings,
  maxVectorGlyphs,
  magneticParts,
  selectedSnapshotQuery,
  vectorDomain,
}: {
  getPartSettings: (
    part: Viewport3DPlanMeshPart,
  ) => Viewport3DScopedPartFieldSettingsForPlanning;
  maxVectorGlyphs: number;
  magneticParts: readonly Viewport3DPlanPartModel[];
  selectedSnapshotQuery?: FieldVectorQuery | null;
  vectorDomain: string;
}): Viewport3DScopedPartVectorFieldDemandPlan {
  if (vectorDomain === "airbox_only") {
    return {
      demands: [],
      requests: new Map(),
    };
  }

  const visiblePartsByQuantity = new Map<string, number>();
  const scalarPartsByQuantityAndMode = new Map<string, number>();
  for (const partModel of magneticParts) {
    const settings = getPartSettings(partModel.part);
    if (!settings.visible) continue;
    const quantityId = resolveCanonicalQuantityId(settings.activeQuantityId);
    visiblePartsByQuantity.set(
      quantityId,
      (visiblePartsByQuantity.get(quantityId) ?? 0) + 1,
    );
    const surfaceColorMode = settings.shaderVisible
      ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
      : null;
    if (!surfaceColorMode) continue;
    const groupKey = `${quantityId}\u0000${surfaceColorMode}`;
    scalarPartsByQuantityAndMode.set(
      groupKey,
      (scalarPartsByQuantityAndMode.get(groupKey) ?? 0) + 1,
    );
  }

  const demands: Viewport3DPassDemand[] = [];
  const requests = new Map<string, Viewport3DFieldResourceRequest>();
  for (const partModel of magneticParts) {
    const settings = getPartSettings(partModel.part);
    if (!settings.visible) continue;
    const quantityId = resolveCanonicalQuantityId(settings.activeQuantityId);
    const surfaceColorMode = settings.shaderVisible
      ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
      : null;
    const vectorsVisible =
      settings.vectorsVisible && settings.vectorBudget > 0;
    if (!surfaceColorMode && !vectorsVisible) continue;
    const fieldRequest = resolveViewport3DScopedPartFieldRequest({
      maxSamples: clampViewport3DInteractiveVectorBudgetForPlanning(
        settings.vectorBudget,
        maxVectorGlyphs,
      ),
      part: partModel.part,
      quantityId,
      replayQuery: selectedSnapshotQuery,
      settings,
    });
    demands.push(...fieldRequest.demands);
    if (
      !vectorsVisible &&
      surfaceColorMode &&
      scalarPartsByQuantityAndMode.get(`${quantityId}\u0000${surfaceColorMode}`) ===
        visiblePartsByQuantity.get(quantityId) &&
      visiblePartsByQuantity.get(quantityId)! > 1
    ) {
      continue;
    }
    if (fieldRequest.request) {
      requests.set(partModel.part.id, fieldRequest.request);
    }
  }

  return {
    demands,
    requests: new Map(
      Array.from(requests).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

export function resolveViewport3DTargetQuantityFieldDemandPlan({
  availableQuantityIds,
  fieldCatalog,
  fdmAirboxSettings,
  fdmSettings,
  fdmTargetSettings = [],
  getPartSettings,
  magneticPartScopedFieldIds,
  magneticParts,
  maxVectorGlyphs,
  primaryFieldQuantityId,
  selectedSnapshotQuery,
}: Viewport3DTargetQuantityFieldRequestsOptions): Viewport3DTargetQuantityFieldDemandPlan {
  const demands: Viewport3DPassDemand[] = [];

  for (const partModel of magneticParts) {
    if (magneticPartScopedFieldIds.has(partModel.part.id)) continue;
    const settings = getPartSettings(partModel.part);
    const quantityId = resolveCanonicalQuantityId(settings.activeQuantityId);
    if (
      !isViewport3DQuantityAvailable(quantityId, availableQuantityIds) ||
      sameViewport3DQuantityIdForPlanning(quantityId, primaryFieldQuantityId) ||
      !settings.visible ||
      (!settings.shaderVisible && !settings.vectorsVisible)
    ) {
      continue;
    }
    demands.push(
      ...buildViewport3DPassDemands(
        buildViewport3DTargetRenderPlan({
          label: partModel.part.label ?? partModel.part.id,
          quantityId,
          settings,
          targetId: partModel.part.id,
          targetKind: "part",
        }),
        {
          maxSamples: clampViewport3DInteractiveVectorBudgetForPlanning(
            settings.vectorBudget,
            maxVectorGlyphs,
          ),
          replayQuery: selectedSnapshotQuery,
          scopeId: partModel.part.id,
          scopeKind: "part",
        },
      ),
    );
  }

  for (const target of fdmTargetSettings) {
    if (
      sameViewport3DQuantityIdForPlanning(
        target.settings.activeQuantityId,
        primaryFieldQuantityId,
      ) ||
      !target.settings.visible ||
      (!target.settings.shaderVisible && !target.settings.vectorsVisible)
    ) {
      continue;
    }
    const quantityId = resolveCanonicalQuantityId(target.settings.activeQuantityId);
    if (
      !isViewport3DQuantityAvailable(quantityId, availableQuantityIds) ||
      (target.targetId === "fdm-universe-outside-support" &&
        fieldCatalog &&
        !fieldCatalogQuantitySupportsAirbox(fieldCatalog, quantityId))
    ) {
      continue;
    }
    demands.push(
      ...buildViewport3DPassDemands(
        buildViewport3DTargetRenderPlan({
          label: target.label,
          quantityId,
          settings: target.settings,
          targetId: target.targetId,
          targetKind: "fdm-domain",
        }),
        {
          forceComplete: target.targetId !== "fdm-universe-outside-support",
          maxSamples: clampViewport3DInteractiveVectorBudgetForPlanning(
            target.settings.vectorBudget,
            maxVectorGlyphs,
          ),
          replayQuery: selectedSnapshotQuery,
          scopeId: null,
          scopeKind: "full",
        },
      ),
    );
  }

  for (const target of [
    fdmSettings
      ? { label: "FDM domain", settings: fdmSettings, targetId: "fdm-domain" }
      : null,
    fdmAirboxSettings
      ? {
          label: "FDM Airbox",
          settings: fdmAirboxSettings,
          targetId: "fdm-universe-outside-support",
        }
      : null,
  ]) {
    if (
      !target ||
      sameViewport3DQuantityIdForPlanning(
        target.settings.activeQuantityId,
        primaryFieldQuantityId,
      ) ||
      !target.settings.visible ||
      (!target.settings.shaderVisible && !target.settings.vectorsVisible)
    ) {
      continue;
    }
    const quantityId = resolveCanonicalQuantityId(target.settings.activeQuantityId);
    if (
      !isViewport3DQuantityAvailable(quantityId, availableQuantityIds) ||
      (target.targetId === "fdm-universe-outside-support" &&
        fieldCatalog &&
        !fieldCatalogQuantitySupportsAirbox(fieldCatalog, quantityId))
    ) {
      continue;
    }
    demands.push(
      ...buildViewport3DPassDemands(
        buildViewport3DTargetRenderPlan({
          label: target.label,
          quantityId,
          settings:
            target.targetId === "fdm-universe-outside-support"
              ? { ...target.settings, shaderVisible: false }
              : target.settings,
          targetId: target.targetId,
          targetKind: "fdm-domain",
        }),
        {
          forceComplete: target.targetId !== "fdm-universe-outside-support",
          maxSamples: clampViewport3DInteractiveVectorBudgetForPlanning(
            target.settings.vectorBudget,
            maxVectorGlyphs,
          ),
          replayQuery: selectedSnapshotQuery,
          scopeId: null,
          scopeKind:
            target.targetId === "fdm-universe-outside-support"
              ? "airbox"
              : "full",
        },
      ),
    );
  }

  const requests = planViewport3DFieldResourceRequests(demands);
  return {
    demands,
    requests: new Map(
      requests
        .filter((request) =>
          !sameViewport3DQuantityIdForPlanning(
            request.quantityId,
            primaryFieldQuantityId,
          ),
        )
        .map((request): [string, Viewport3DFieldResourceRequest] => [
          request.requestId,
          request,
        ])
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
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

export function validateViewport3DFieldResourceRequestIdentities(
  requests: Iterable<readonly [string, Viewport3DFieldResourceRequest]>,
): string[] {
  const issues: string[] = [];
  for (const [targetId, request] of requests) {
    const expected = buildViewport3DFieldResourceRequestId(
      request.quantityId,
      request.query,
    );
    if (request.requestId !== expected) {
      issues.push(
        [
          "request-id-mismatch",
          `target=${targetId}`,
          `expected=${expected}`,
          `actual=${request.requestId}`,
        ].join(" "),
      );
    }
  }
  return issues;
}

export function validateViewport3DFieldResourceRequestEquivalence(
  requests: Iterable<readonly [string, Viewport3DFieldResourceRequest]>,
): string[] {
  const requestsById = new Map<string, {
    consumers: Set<string>;
    targets: Set<string>;
  }>();
  for (const [targetId, request] of requests) {
    const requestId = buildViewport3DFieldResourceRequestId(
      request.quantityId,
      request.query,
    );
    const entry = requestsById.get(requestId);
    if (entry) {
      entry.targets.add(targetId);
      for (const consumer of request.consumers) {
        entry.consumers.add(consumer);
      }
    } else {
      requestsById.set(requestId, {
        consumers: new Set(request.consumers),
        targets: new Set([targetId]),
      });
    }
  }

  return Array.from(requestsById, ([requestId, entry]) => ({
    consumers: Array.from(entry.consumers).sort(),
    requestId,
    targets: Array.from(entry.targets).sort(),
  }))
    .filter((entry) => entry.targets.length > 1)
    .map((entry) =>
      [
        "duplicate-equivalent-request",
        `request=${entry.requestId}`,
        `targets=${entry.targets.join(",")}`,
        `consumers=${entry.consumers.join(",")}`,
      ].join(" "),
    );
}

export function resolveViewport3DTargetFieldQuery({
  quantityId,
  surfaceColorMode,
  vectorsVisible,
}: {
  quantityId?: string | null;
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

  if (quantityId && isScalarSpatialQuantityId(quantityId)) {
    return {
      component: "full",
      scope_kind: "full",
    };
  }

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
  quantityId,
  surfaceColorMode,
  vectorsVisible,
}: {
  maxSamples: number;
  quantityId?: string | null;
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery {
  const query = resolveViewport3DTargetFieldQuery({
    quantityId,
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
  const replayQuery = replayFieldQueryForMerge(current, next);
  const scopeQuery = scopedFieldQueryForMerge(current, next);
  const component =
    current.component === "full" || next.component === "full"
      ? "full"
      : current.component === next.component
        ? current.component
        : "full";
  if (component === "full") {
    return {
      component: "full",
      ...scopeQuery,
      ...replayQuery,
    };
  }
  return {
    component,
    ...scopeQuery,
    ...replayQuery,
  };
}

function replayFieldQueryForMerge(
  current: FieldVectorQuery,
  next: FieldVectorQuery,
): Pick<FieldVectorQuery, "phase_rad" | "snapshot_id" | "stage_id" | "view"> {
  return dropUndefinedFieldQueryValues({
    phase_rad: next.phase_rad ?? current.phase_rad,
    snapshot_id: next.snapshot_id ?? current.snapshot_id,
    stage_id: next.stage_id ?? current.stage_id,
    view: next.view ?? current.view,
  });
}

function scopedFieldQueryForMerge(
  current: FieldVectorQuery,
  next: FieldVectorQuery,
): Pick<FieldVectorQuery, "scope_id" | "scope_kind"> {
  const currentScopeKind = current.scope_kind ?? "full";
  const nextScopeKind = next.scope_kind ?? "full";
  const currentScopeId = current.scope_id ?? null;
  const nextScopeId = next.scope_id ?? null;
  if (
    currentScopeKind === nextScopeKind &&
    currentScopeId === nextScopeId
  ) {
    return dropUndefinedFieldQueryValues({
      scope_id: currentScopeId ?? undefined,
      scope_kind: currentScopeKind,
    });
  }
  throw new Error(
    [
      "Cannot merge viewport 3D field queries for different scopes",
      `${currentScopeKind}:${currentScopeId ?? "none"}`,
      `${nextScopeKind}:${nextScopeId ?? "none"}`,
    ].join(": "),
  );
}

function dropUndefinedFieldQueryValues<T extends Partial<FieldVectorQuery>>(
  query: T,
): T {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  ) as T;
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
    replayQuery: mergeReplayFieldQuery(current.replayQuery, next.replayQuery),
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
    ...dropUndefinedFieldQueryValues(demand.replayQuery ?? {}),
    scope_kind: demand.scopeKind,
  };
  if (demand.scopeId) query.scope_id = demand.scopeId;
  if (demand.completeness === "sampled-ok" && demand.maxSamples != null) {
    const maxSamples = Math.max(0, Math.floor(demand.maxSamples));
    if (maxSamples > 0) query.max_samples = maxSamples;
  }
  return query;
}

function resolveViewport3DPrimaryFieldPassDemands({
  fdmInstanceModelNeedsFieldVector,
  fdmSurfaceColorMode,
  fdmTopographyEnabled,
  fdmVectorsVisible,
  fieldRenderOptions,
  primaryFieldQuantityId,
  snapshotId,
  snapshotQuery,
}: Viewport3DPrimaryFieldQueryOptions & {
  primaryFieldQuantityId: string;
  snapshotId?: string | null;
  snapshotQuery?: FieldVectorQuery | null;
}): Viewport3DPassDemand[] {
  const replayQuery = snapshotQuery ?? (snapshotId ? { snapshot_id: snapshotId } : null);
  const demands: Viewport3DPassDemand[] = [];
  const scalarFieldComponentRequest = resolveViewport3DScalarComponentRequest(
    fieldRenderOptions.scalarColorsVisible === false
      ? null
      : fieldRenderOptions.scalarColorModes,
    fdmSurfaceColorMode,
  );
  if (
    fieldRenderOptions.scalarColorsVisible !== false &&
    (scalarFieldComponentRequest.component ||
      scalarFieldComponentRequest.needsFullVector)
  ) {
    demands.push({
      component: scalarFieldComponentRequest.needsFullVector
        ? "full"
        : scalarFieldComponentRequest.component ?? "full",
      completeness: "complete",
      maxSamples: null,
      passId: "primary-field:surface",
      passKind: "surface",
      quantityId: primaryFieldQuantityId,
      replayQuery,
      scopeId: null,
      scopeKind: "full",
      targetId: "primary-field",
    });
  }

  if (
    fdmVectorsVisible ||
    fdmTopographyEnabled ||
    fdmInstanceModelNeedsFieldVector ||
    (fieldRenderOptions.fullVectorBudget ?? 0) > 0 ||
    mapHasPositiveValue(fieldRenderOptions.partVectorBudgets)
  ) {
    demands.push({
      component: "full",
      completeness: "complete",
      maxSamples: null,
      passId: "primary-field:vector-glyph",
      passKind: "vector-glyph",
      quantityId: primaryFieldQuantityId,
      replayQuery,
      scopeId: null,
      scopeKind: "full",
      targetId: "primary-field",
    });
  }

  return demands;
}

function resolveViewport3DScopedPartFieldRequest({
  maxSamples,
  part,
  quantityId,
  replayQuery,
  settings,
}: {
  maxSamples: number;
  part: Viewport3DPlanMeshPart;
  quantityId: string;
  replayQuery?: FieldVectorQuery | null;
  settings: Viewport3DScopedPartFieldSettingsForPlanning;
}): Viewport3DScopedPartFieldDemandPlan {
  const plan = buildViewport3DTargetRenderPlan({
    label: part.label ?? part.id,
    quantityId,
    settings: {
      geometryScope: "full",
      scalarColorPalette: "viridis",
      shaderMonoColor: DEFAULT_VIEWPORT3D_SHADER_MONO_COLOR,
      shaderVisible: settings.shaderVisible,
      surfaceColorSource: settings.surfaceColorSource,
      surfaceProjectionMode: settings.surfaceProjectionMode,
      vectorBudget: settings.vectorBudget,
      vectorCenteringEnabled: true,
      vectorColorMode: "orientation",
      vectorLengthScale: 1,
      vectorSurfaceOffsetEnabled: false,
      vectorSurfaceOffsetScale: 0,
      vectorsVisible: settings.vectorsVisible,
      viewportColorbarVisible: false,
      visible: settings.visible,
    },
    targetId: part.id,
    targetKind: "part",
  });
  const demands = buildViewport3DPassDemands(plan, {
    maxSamples,
    replayQuery,
    scopeId: part.id,
    scopeKind: "part",
  });
  const [request] = planViewport3DFieldResourceRequests(demands);
  return {
    demands,
    request: request ?? null,
  };
}

function viewport3DFieldRenderOptionsNeedFullVectorData(
  options: Viewport3DPrimaryFieldRenderOptionsForPlanning,
): boolean {
  if ((options.fullVectorBudget ?? 0) > 0) return true;
  if (mapHasPositiveValue(options.partVectorBudgets)) return true;

  if (options.scalarColorsVisible === false) return false;
  return resolveViewport3DScalarComponentRequest(options.scalarColorModes, null)
    .needsFullVector;
}

function mapHasPositiveValue(
  values: ReadonlyMap<string, number> | null | undefined,
): boolean {
  if (!values) return false;
  for (const value of values.values()) {
    if (value > 0) return true;
  }
  return false;
}

function clampViewport3DInteractiveVectorBudgetForPlanning(
  requestedBudget: number,
  maxVectorGlyphs: number,
): number {
  const requested = Math.max(0, Math.floor(requestedBudget));
  const max = Math.max(0, Math.floor(maxVectorGlyphs));
  if (requested <= 0 || max <= 0) return 0;
  return Math.min(requested, max);
}

function sameViewport3DQuantityIdForPlanning(left: string, right: string): boolean {
  return (
    resolveCanonicalQuantityId(left) === resolveCanonicalQuantityId(right)
  );
}

function fieldDemandBaseKey(demand: Viewport3DPassDemand): string {
  return [
    resolveCanonicalQuantityId(demand.quantityId),
    demand.scopeKind,
    demand.scopeId ?? "",
    replayFieldQueryKey(demand.replayQuery),
  ].join("\u0000");
}

function targetFieldDemandDiagnosticSummary(
  summaries: Map<string, {
    demands: string[];
    requestKeys: Set<string>;
    requests: string[];
  }>,
  targetId: string,
): {
  demands: string[];
  requestKeys: Set<string>;
  requests: string[];
} {
  const current = summaries.get(targetId);
  if (current) return current;
  const summary = {
    demands: [],
    requestKeys: new Set<string>(),
    requests: [],
  };
  summaries.set(targetId, summary);
  return summary;
}

function summarizeViewport3DPassDemand(
  demand: Viewport3DPassDemand,
): string {
  const parts = [
    demand.passKind,
    demand.component,
    demand.completeness,
  ];
  const summary = parts.join(":");
  return demand.maxSamples != null
    ? `${summary} max_samples=${Math.max(0, Math.floor(demand.maxSamples))}`
    : summary;
}

function normalizeReplayFieldQuery(
  query: Viewport3DReplayFieldQuery | null | undefined,
): Viewport3DReplayFieldQuery | null {
  const normalized = dropUndefinedFieldQueryValues({
    phase_rad: query?.phase_rad,
    snapshot_id: query?.snapshot_id,
    stage_id: query?.stage_id,
    view: query?.view,
  });
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function mergeReplayFieldQuery(
  current: Viewport3DReplayFieldQuery | null,
  next: Viewport3DReplayFieldQuery | null,
): Viewport3DReplayFieldQuery | null {
  const currentKey = replayFieldQueryKey(current);
  const nextKey = replayFieldQueryKey(next);
  if (currentKey === nextKey) return current ?? next;
  throw new Error(
    [
      "Cannot merge viewport 3D field demands for different replay queries",
      currentKey,
      nextKey,
    ].join(": "),
  );
}

function replayFieldQueryKey(
  query: Viewport3DReplayFieldQuery | null,
): string {
  const normalized = normalizeReplayFieldQuery(query);
  if (!normalized) return "live";
  return [
    normalized.snapshot_id ? `snapshot=${normalized.snapshot_id}` : null,
    normalized.stage_id ? `stage=${normalized.stage_id}` : null,
    normalized.view ? `view=${normalized.view}` : null,
    normalized.phase_rad != null ? `phase=${normalized.phase_rad}` : null,
  ].filter(Boolean).join("|") || "live";
}

function summarizeViewport3DFieldResourceRequest(
  request: Viewport3DFieldResourceRequest,
): string {
  const query = request.query;
  const parts = [
    `quantity=${resolveCanonicalQuantityId(request.quantityId)}`,
    `component=${query.component ?? "full"}`,
    `scope=${query.scope_kind ?? "full"}:${query.scope_id ?? "none"}`,
  ];
  if (query.max_samples != null) {
    parts.push(`max_samples=${Math.max(0, Math.floor(query.max_samples))}`);
  }
  if (query.snapshot_id) parts.push(`snapshot_id=${query.snapshot_id}`);
  if (query.stage_id) parts.push(`stage_id=${query.stage_id}`);
  if (query.view) parts.push(`view=${query.view}`);
  if (query.phase_rad != null) parts.push(`phase_rad=${query.phase_rad}`);
  parts.push(`consumers=${request.consumers.join(",")}`);
  return parts.join(" ");
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
