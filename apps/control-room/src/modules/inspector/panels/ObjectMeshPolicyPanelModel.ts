import type {
  JsonObject,
  JsonValue,
  MeshCapabilitiesResource,
  MeshCapabilityMatrixResource,
  MeshFeatureCapabilityResource,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
} from "@/kernel/api/apiTypes";
import { defaultObjectMeshPolicyResource } from "@/kernel/resources/geometryLifecycleResources";

export { defaultObjectMeshPolicyResource };

const OBJECT_POLICY_MANUAL_BOX_SOURCE = "object_policy_manual_box";
const OBJECT_CORE_RELAXATION_KIND = "ObjectCoreRelaxation";
const UNMARKED_MANUAL_BOX_SOURCE = "unmarked_manual_box";

export interface ObjectMeshPolicyDraft {
  algorithm2d: string;
  algorithm3d: string;
  boundaryLayerCount: string;
  boundaryLayerStretching: string;
  boundaryLayerTargetCurveSelectors: string;
  boundaryLayerTargetCurveTags: string;
  boundaryLayerTargetSurfaceSelectors: string;
  boundaryLayerTargetSurfaceTags: string;
  boundaryLayerThickness: string;
  computeQuality: string;
  coreRelaxationEdgeDistance: string;
  coreRelaxationEdgeMaximumElementSize: string;
  coreRelaxationEnabled: boolean;
  coreRelaxationGeometryName: string;
  coreRelaxationMaximumElementSize: string;
  coreRelaxationSamplingEdge: string;
  coreRelaxationSamplingSurface: string;
  coreRelaxationSurfaceDistance: string;
  coreRelaxationSurfaceMaximumElementSize: string;
  cornerExtent: string;
  cornerMaximumElementSize: string;
  cornerTransitionDistance: string;
  configText: string;
  curvatureFactor: string;
  edgeMaximumElementSize: string;
  edgeThickness: string;
  edgeTransitionDistance: string;
  exactLayerCount: string;
  interfaceMaximumElementSize: string;
  interfaceThickness: string;
  manualBoxSizeFieldEnabled: boolean;
  manualBoxSizeFieldSource: string;
  manualBoxSizeFieldVIn: string;
  manualBoxSizeFieldVOut: string;
  manualBoxSizeFieldXMax: string;
  manualBoxSizeFieldXMin: string;
  manualBoxSizeFieldYMax: string;
  manualBoxSizeFieldYMin: string;
  manualBoxSizeFieldZMax: string;
  manualBoxSizeFieldZMin: string;
  maximumElementGrowthRate: string;
  maximumElementSize: string;
  meshStrategy: string;
  minimumElementSize: string;
  narrowRegions: string;
  narrowRegionResolution: string;
  order: string;
  optimize: string;
  optimizeIterations: string;
  perElementQuality: string;
  present: boolean;
  source: string;
  smoothingSteps: string;
  sweepFaceMeshing: string;
  sweepDestination: string;
  sweepSource: string;
  calibrateFor: string;
  sizePreset: string;
  sizeFactor: string;
  sizeFromCurvature: string;
  throughThicknessDistribution: string;
  throughThicknessElementRatio: string;
  throughThicknessElements: string;
  throughThicknessSymmetric: string;
  topology: string;
  transitionDistance: string;
  transitionGrowth: string;
  transitionPolicy: string;
}

export interface ObjectMeshTopologyCapabilityOption {
  enabled: boolean;
  reason: string;
  status: string;
  supportedLayerCounts: readonly number[];
}

export interface ObjectMeshTopologyCapabilities {
  layeredPrism: ObjectMeshTopologyCapabilityOption;
  sweptHex: ObjectMeshTopologyCapabilityOption;
}

const LAYERED_PRISM_CAPABILITY_IDS = [
  "mesh.topology.mixed_p1",
  "mesh.swept.prism",
  "mesh.transition.pyramid_tet",
  "mesh.exact_layer_count",
] as const;

const LAYERED_PRISM_EXECUTABLE_STATUSES = new Set([
  "production_executable",
  "validated",
]);

function capabilityValue(
  capabilities: MeshCapabilityMatrixResource | null | undefined,
  id: (typeof LAYERED_PRISM_CAPABILITY_IDS)[number],
): MeshFeatureCapabilityResource | null | undefined {
  return capabilities?.[id];
}

function capabilityStatus(
  value: MeshFeatureCapabilityResource | null | undefined,
): string {
  return value?.status ?? "unavailable";
}

function capabilityReason(
  value: MeshFeatureCapabilityResource | null | undefined,
  id: string,
  status: string,
): string {
  if (value?.reason?.trim()) return value.reason;
  return status === "unavailable"
    ? `Capability ${id} is not advertised by the meshing resource.`
    : `Capability ${id} is ${status}.`;
}

export function resolveObjectMeshTopologyCapabilities(
  resource: Pick<MeshCapabilitiesResource, "mesh_capabilities"> | null | undefined,
): ObjectMeshTopologyCapabilities {
  const capabilities = resource?.mesh_capabilities;
  let allValidated = true;
  for (const id of LAYERED_PRISM_CAPABILITY_IDS) {
    const value = capabilityValue(capabilities, id);
    const status = capabilityStatus(value);
    if (!LAYERED_PRISM_EXECUTABLE_STATUSES.has(status)) {
      return {
        layeredPrism: {
          enabled: false,
          reason: capabilityReason(value, id, status),
          status,
          supportedLayerCounts: [],
        },
        sweptHex: {
          enabled: false,
          reason: "Swept hex has not passed the mixed-P1 capability gate.",
          status: "unsupported",
          supportedLayerCounts: [],
        },
      };
    }
    allValidated &&= status === "validated";
  }
  const exactLayerCount = capabilityValue(capabilities, "mesh.exact_layer_count");
  const supportedLayerCounts = (exactLayerCount?.supported_layer_counts ?? []).filter(
    (value) => Number.isInteger(value) && value > 0,
  );
  if (
    supportedLayerCounts.length !== 3 ||
    supportedLayerCounts.some((value, index) => value !== index + 1)
  ) {
    return {
      layeredPrism: {
        enabled: false,
        reason:
          "Capability mesh.exact_layer_count must advertise supported_layer_counts=[1,2,3].",
        status: "invalid_scope",
        supportedLayerCounts,
      },
      sweptHex: {
        enabled: false,
        reason: "Swept hex has not passed the mixed-P1 capability gate.",
        status: "unsupported",
        supportedLayerCounts: [],
      },
    };
  }
  return {
    layeredPrism: {
      enabled: true,
      reason: "All exact layered prism capabilities are executable.",
      status: allValidated ? "validated" : "production_executable",
      supportedLayerCounts,
    },
    sweptHex: {
      enabled: false,
      reason: "Swept hex has not passed the mixed-P1 capability gate.",
      status: "unsupported",
      supportedLayerCounts: [],
    },
  };
}

export function nodePlaneCount(layerText: string): number | null {
  const layers = Number(layerText);
  return Number.isInteger(layers) && layers > 0 ? layers + 1 : null;
}

function requestsExactLayeredPrism(config: JsonObject): boolean {
  return (
    config.mesh_strategy === "swept_prism" ||
    config.topology === "prismatic" ||
    config.element_family === "prism" ||
    config.exact_layer_count === true
  );
}

export function validateObjectMeshTopologyCapabilities(
  draft: ObjectMeshPolicyDraft,
  capabilities: ObjectMeshTopologyCapabilities,
): string | null {
  const rawConfig = parseConfig(draft.configText);
  const built = buildObjectMeshPolicyReplaceRequest(draft);
  const rawRequestsMixed = rawConfig.ok && requestsExactLayeredPrism(rawConfig.value);
  const builtRequestsMixed =
    "request" in built &&
    built.request.config !== null &&
    requestsExactLayeredPrism(built.request.config ?? {});
  if (!rawRequestsMixed && !builtRequestsMixed) return null;
  if (!capabilities.layeredPrism.enabled) {
    return `Exact layered prism authoring is unavailable: ${capabilities.layeredPrism.reason}`;
  }
  const builtConfig = "request" in built ? built.request.config : null;
  const requestedLayerCounts = [
    rawConfig.ok ? rawConfig.value.through_thickness_elements : undefined,
    builtConfig?.through_thickness_elements,
  ].filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value),
  );
  if (
    requestedLayerCounts.some(
      (layerCount) =>
        !capabilities.layeredPrism.supportedLayerCounts.includes(layerCount),
    )
  ) {
    return `Exact layered prism supports ${capabilities.layeredPrism.supportedLayerCounts.join(
      ", ",
    )} through-thickness elements.`;
  }
  return null;
}

export function formatObjectMeshPolicyConfig(
  config: JsonObject | null | undefined,
): string {
  if (!config || Object.keys(config).length === 0) return "{}";
  return JSON.stringify(config, null, 2);
}

export function draftFromObjectMeshPolicyResource(
  resource: MeshObjectConfigResource,
  options: {
    effectiveTarget?: JsonObject | null | undefined;
  } = {},
): ObjectMeshPolicyDraft {
  const config = {
    ...defaultObjectMeshPolicyConfig(),
    ...targetConfigFromEffectiveObject(options.effectiveTarget),
    ...(resource.effective_config ?? {}),
    ...(resource.config ?? {}),
  };
  const manualBox = readManualBoxSizeField(config.size_fields);
  const coreRelaxation = readObjectCoreRelaxationSizeField(config.size_fields);

  return {
    algorithm2d: readNumberText(config.algorithm_2d),
    algorithm3d: readNumberText(config.algorithm_3d),
    boundaryLayerCount: readNumberText(config.boundary_layer_count),
    boundaryLayerStretching: readNumberText(config.boundary_layer_stretching),
    boundaryLayerTargetCurveSelectors: readJsonArrayText(
      config.boundary_layer_target_curve_selectors,
    ),
    boundaryLayerTargetCurveTags: readIntegerListText(
      config.boundary_layer_target_curve_tags,
    ),
    boundaryLayerTargetSurfaceSelectors: readJsonArrayText(
      config.boundary_layer_target_surface_selectors,
    ),
    boundaryLayerTargetSurfaceTags: readIntegerListText(
      config.boundary_layer_target_surface_tags,
    ),
    boundaryLayerThickness: readNumberText(config.boundary_layer_thickness),
    computeQuality: readBooleanText(config.compute_quality),
    coreRelaxationEdgeDistance: coreRelaxation.edgeDistance,
    coreRelaxationEdgeMaximumElementSize: coreRelaxation.edgeMaximumElementSize,
    coreRelaxationEnabled: coreRelaxation.enabled,
    coreRelaxationGeometryName: coreRelaxation.geometryName,
    coreRelaxationMaximumElementSize: coreRelaxation.maximumElementSize,
    coreRelaxationSamplingEdge: coreRelaxation.samplingEdge,
    coreRelaxationSamplingSurface: coreRelaxation.samplingSurface,
    coreRelaxationSurfaceDistance: coreRelaxation.surfaceDistance,
    coreRelaxationSurfaceMaximumElementSize:
      coreRelaxation.surfaceMaximumElementSize,
    cornerExtent: readNumberText(config.corner_extent),
    cornerMaximumElementSize: readNumberText(config.corner_maximum_element_size),
    cornerTransitionDistance: readTransitionDistanceText(
      config.corner_transition_distance,
    ),
    calibrateFor: readStringText(config.calibrate_for),
    configText: formatObjectMeshPolicyConfig(resource.config),
    curvatureFactor: readNumberText(config.curvature_factor),
    edgeMaximumElementSize: readNumberText(config.edge_maximum_element_size),
    edgeThickness: readNumberText(config.edge_thickness),
    edgeTransitionDistance: readTransitionDistanceText(
      config.edge_transition_distance,
    ),
    exactLayerCount: readBooleanText(config.exact_layer_count),
    interfaceMaximumElementSize: readNumberText(
      config.interface_hmax ?? config.interface_maximum_element_size,
    ),
    interfaceThickness: readNumberText(config.interface_thickness),
    manualBoxSizeFieldEnabled: manualBox.enabled,
    manualBoxSizeFieldSource: manualBox.source,
    manualBoxSizeFieldVIn: manualBox.vIn,
    manualBoxSizeFieldVOut: manualBox.vOut,
    manualBoxSizeFieldXMax: manualBox.xMax,
    manualBoxSizeFieldXMin: manualBox.xMin,
    manualBoxSizeFieldYMax: manualBox.yMax,
    manualBoxSizeFieldYMin: manualBox.yMin,
    manualBoxSizeFieldZMax: manualBox.zMax,
    manualBoxSizeFieldZMin: manualBox.zMin,
    maximumElementGrowthRate: readNumberText(
      config.maximum_element_growth_rate ?? config.growth_rate,
    ),
    maximumElementSize: readNumberText(config.maximum_element_size),
    meshStrategy: readStringText(config.mesh_strategy),
    minimumElementSize: readNumberText(config.minimum_element_size),
    narrowRegions: readNumberText(config.narrow_regions),
    narrowRegionResolution: readNumberText(config.narrow_region_resolution),
    order: readNumberText(config.order),
    optimize: readStringText(config.optimize),
    optimizeIterations: readNumberText(config.optimize_iterations),
    perElementQuality: readBooleanText(config.per_element_quality),
    present: resource.config !== null && resource.config !== undefined,
    source: readStringText(config.source),
    sizeFactor: readNumberText(config.size_factor),
    sizeFromCurvature: readNumberText(config.size_from_curvature),
    sizePreset: readStringText(config.size_preset),
    smoothingSteps: readNumberText(config.smoothing_steps),
    sweepFaceMeshing: readStringText(config.sweep_face_meshing),
    sweepDestination: readStringText(config.sweep_destination),
    sweepSource: readStringText(config.sweep_source),
    throughThicknessDistribution: readStringText(
      config.through_thickness_distribution,
    ),
    throughThicknessElementRatio: readNumberText(
      config.through_thickness_element_ratio,
    ),
    throughThicknessElements: readNumberText(config.through_thickness_elements),
    throughThicknessSymmetric: readBooleanText(config.through_thickness_symmetric),
    topology: readStringText(config.topology),
    transitionDistance: readTransitionDistanceText(config.transition_distance),
    transitionGrowth: readNumberText(config.transition_growth),
    transitionPolicy: readStringText(config.transition_policy),
  };
}

export function draftKeyForObjectMeshPolicyResource(
  objectId: string | null | undefined,
  resource: MeshObjectConfigResource,
  options: {
    effectiveTarget?: JsonObject | null | undefined;
  } = {},
): string {
  const effectiveTarget = targetConfigFromEffectiveObject(options.effectiveTarget);
  return [
    objectId ?? "",
    resource.revision,
    formatObjectMeshPolicyConfig(resource.config),
    formatObjectMeshPolicyConfig(resource.effective_config),
    formatObjectMeshPolicyConfig(effectiveTarget),
  ].join(":");
}

export function draftIdentityKeyForObjectMeshPolicyResource(
  objectId: string | null | undefined,
): string {
  return objectId ?? "";
}

export function objectMeshPolicyDraftDirty(
  draft: ObjectMeshPolicyDraft,
  baseDraft: ObjectMeshPolicyDraft,
): boolean {
  return !draftRecordsEqual(
    draft as unknown as Record<string, unknown>,
    baseDraft as unknown as Record<string, unknown>,
  );
}

function defaultObjectMeshPolicyConfig(): JsonObject {
  return {
    algorithm_2d: 6,
    algorithm_3d: 1,
    build_requested: false,
    compute_quality: true,
    mode: "inherit",
    narrow_regions: 0,
    optimize_iterations: 1,
    per_element_quality: true,
    size_factor: 1,
    size_from_curvature: 0,
    smoothing_steps: 1,
    through_thickness_symmetric: false,
  };
}

function targetConfigFromEffectiveObject(
  target: JsonObject | null | undefined,
): JsonObject {
  if (!target) return {};
  const config: JsonObject = {};
  const hmax = target.maximum_element_size ?? target.hmax;
  const hmin = target.minimum_element_size ?? target.hmin;
  const growthRate = target.growth_rate ?? target.maximum_element_growth_rate;
  if (isFiniteNumberLike(hmax)) config.maximum_element_size = hmax;
  if (isFiniteNumberLike(hmin)) config.minimum_element_size = hmin;
  if (isFiniteNumberLike(growthRate)) {
    config.maximum_element_growth_rate = growthRate;
  }
  return config;
}

export function buildObjectMeshPolicyReplaceRequest({
  cornerExtent,
  cornerMaximumElementSize,
  cornerTransitionDistance,
  algorithm2d,
  algorithm3d,
  boundaryLayerCount,
  boundaryLayerStretching,
  boundaryLayerTargetCurveSelectors,
  boundaryLayerTargetCurveTags,
  boundaryLayerTargetSurfaceSelectors,
  boundaryLayerTargetSurfaceTags,
  boundaryLayerThickness,
  computeQuality,
  coreRelaxationEdgeDistance,
  coreRelaxationEdgeMaximumElementSize,
  coreRelaxationEnabled,
  coreRelaxationGeometryName,
  coreRelaxationMaximumElementSize,
  coreRelaxationSamplingEdge,
  coreRelaxationSamplingSurface,
  coreRelaxationSurfaceDistance,
  coreRelaxationSurfaceMaximumElementSize,
  configText,
  curvatureFactor,
  edgeMaximumElementSize,
  edgeThickness,
  edgeTransitionDistance,
  exactLayerCount,
  interfaceMaximumElementSize,
  interfaceThickness,
  manualBoxSizeFieldEnabled,
  manualBoxSizeFieldSource,
  manualBoxSizeFieldVIn,
  manualBoxSizeFieldVOut,
  manualBoxSizeFieldXMax,
  manualBoxSizeFieldXMin,
  manualBoxSizeFieldYMax,
  manualBoxSizeFieldYMin,
  manualBoxSizeFieldZMax,
  manualBoxSizeFieldZMin,
  maximumElementGrowthRate,
  maximumElementSize,
  meshStrategy,
  minimumElementSize,
  narrowRegions,
  narrowRegionResolution,
  order,
  optimize,
  optimizeIterations,
  perElementQuality,
  present,
  source,
  smoothingSteps,
  calibrateFor,
  sizePreset,
  sizeFactor,
  sizeFromCurvature,
  sweepFaceMeshing,
  sweepDestination,
  sweepSource,
  throughThicknessDistribution,
  throughThicknessElementRatio,
  throughThicknessElements,
  throughThicknessSymmetric,
  topology,
  transitionDistance,
  transitionGrowth,
  transitionPolicy,
}: ObjectMeshPolicyDraft):
  | { error: string }
  | { request: MeshObjectConfigReplaceRequest } {
  if (!present) {
    return { request: { config: null } };
  }

  const config = parseConfig(configText);
  if (!config.ok) return { error: config.error };
  const value = { ...config.value };

  const numericFields: Array<[
    key: string,
    text: string,
    label: string,
    integer?: boolean,
    allowZero?: boolean,
  ]> = [
    ["algorithm_2d", algorithm2d, "Gmsh 2D algorithm", true],
    ["algorithm_3d", algorithm3d, "Gmsh 3D algorithm", true],
    ["maximum_element_size", maximumElementSize, "Maximum element size"],
    ["minimum_element_size", minimumElementSize, "Minimum element size"],
    [
      "maximum_element_growth_rate",
      maximumElementGrowthRate,
      "Maximum element growth rate",
    ],
    ["curvature_factor", curvatureFactor, "Curvature factor"],
    ["narrow_region_resolution", narrowRegionResolution, "Narrow region resolution"],
    ["narrow_regions", narrowRegions, "Narrow regions", true, true],
    ["size_from_curvature", sizeFromCurvature, "Size from curvature", true, true],
    ["size_factor", sizeFactor, "Size factor"],
    ["order", order, "FEM order", true],
    ["smoothing_steps", smoothingSteps, "Smoothing steps", true],
    ["optimize_iterations", optimizeIterations, "Optimizer iterations", true],
    ["boundary_layer_count", boundaryLayerCount, "Boundary-layer count", true],
    [
      "boundary_layer_thickness",
      boundaryLayerThickness,
      "Boundary-layer thickness",
    ],
    [
      "boundary_layer_stretching",
      boundaryLayerStretching,
      "Boundary-layer stretching",
    ],
    [
      "through_thickness_elements",
      throughThicknessElements,
      "Through-thickness elements",
      true,
    ],
    [
      "through_thickness_element_ratio",
      throughThicknessElementRatio,
      "Through-thickness element ratio",
    ],
    ["interface_hmax", interfaceMaximumElementSize, "Interface maximum element size"],
    ["interface_thickness", interfaceThickness, "Interface thickness"],
    ["transition_growth", transitionGrowth, "Transition growth"],
    ["edge_maximum_element_size", edgeMaximumElementSize, "Edge maximum element size"],
    ["edge_thickness", edgeThickness, "Edge thickness"],
    [
      "corner_maximum_element_size",
      cornerMaximumElementSize,
      "Corner maximum element size",
    ],
    ["corner_extent", cornerExtent, "Corner extent"],
  ];

  for (const [key, text, label, integer, allowZero] of numericFields) {
    const parsed = parsePositiveNumber(text, label, integer, allowZero);
    if (!parsed.ok) return { error: parsed.error };
    applyOptionalNumber(value, key, parsed.value);
  }
  delete value.interface_maximum_element_size;

  const transitionDistanceValue = parseTransitionDistance(
    transitionDistance,
    "Transition distance",
  );
  if (!transitionDistanceValue.ok) return { error: transitionDistanceValue.error };
  applyOptionalTransitionDistance(
    value,
    "transition_distance",
    transitionDistanceValue.value,
  );

  const edgeTransitionDistanceValue = parseTransitionDistance(
    edgeTransitionDistance,
    "Edge transition distance",
  );
  if (!edgeTransitionDistanceValue.ok) {
    return { error: edgeTransitionDistanceValue.error };
  }
  applyOptionalTransitionDistance(
    value,
    "edge_transition_distance",
    edgeTransitionDistanceValue.value,
  );

  const cornerTransitionDistanceValue = parseTransitionDistance(
    cornerTransitionDistance,
    "Corner transition distance",
  );
  if (!cornerTransitionDistanceValue.ok) {
    return { error: cornerTransitionDistanceValue.error };
  }
  applyOptionalTransitionDistance(
    value,
    "corner_transition_distance",
    cornerTransitionDistanceValue.value,
  );

  applyOptionalString(value, "mesh_strategy", meshStrategy);
  applyOptionalString(value, "topology", topology);
  applyOptionalString(value, "transition_policy", transitionPolicy);
  applyOptionalString(value, "optimize", optimize);
  applyOptionalString(value, "source", source);
  applyOptionalString(
    value,
    "through_thickness_distribution",
    throughThicknessDistribution,
  );
  applyOptionalString(value, "sweep_face_meshing", sweepFaceMeshing);
  applyOptionalString(value, "sweep_source", sweepSource);
  applyOptionalString(value, "sweep_destination", sweepDestination);
  applyOptionalString(value, "calibrate_for", calibrateFor);
  applyOptionalString(value, "size_preset", sizePreset);
  applyOptionalBoolean(
    value,
    "through_thickness_symmetric",
    throughThicknessSymmetric,
  );
  applyOptionalBoolean(value, "exact_layer_count", exactLayerCount);
  if (meshStrategy === "swept_prism") {
    const layerCount = value.through_thickness_elements;
    if (
      typeof layerCount === "number" &&
      ![1, 2, 3].includes(layerCount)
    ) {
      return {
        error: "Exact layered prism supports 1, 2, or 3 through-thickness elements.",
      };
    }
    value.topology = "prismatic";
    value.element_family = "prism";
    value.order = 1;
    value.sweep_direction = "auto";
    value.sweep_face_meshing = "triangular";
    value.through_thickness_distribution = "fixed";
    value.through_thickness_element_ratio = 1;
    value.through_thickness_elements ??= 1;
    value.through_thickness_symmetric = false;
    value.transition_policy = "pyramid_to_tetrahedra";
    value.exact_layer_count = true;
  } else if (meshStrategy === "free_tetrahedral") {
    delete value.topology;
    delete value.through_thickness_elements;
    delete value.through_thickness_distribution;
    delete value.through_thickness_element_ratio;
    delete value.through_thickness_symmetric;
    delete value.sweep_face_meshing;
    delete value.sweep_source;
    delete value.sweep_destination;
    delete value.element_family;
    delete value.sweep_direction;
    delete value.transition_policy;
    delete value.exact_layer_count;
  }
  applyOptionalBoolean(value, "compute_quality", computeQuality);
  applyOptionalBoolean(value, "per_element_quality", perElementQuality);
  const surfaceTags = parseIntegerList(
    boundaryLayerTargetSurfaceTags,
    "Boundary-layer surface tags",
  );
  if (!surfaceTags.ok) return { error: surfaceTags.error };
  applyOptionalList(value, "boundary_layer_target_surface_tags", surfaceTags.value);
  const curveTags = parseIntegerList(
    boundaryLayerTargetCurveTags,
    "Boundary-layer curve tags",
  );
  if (!curveTags.ok) return { error: curveTags.error };
  applyOptionalList(value, "boundary_layer_target_curve_tags", curveTags.value);
  const surfaceSelectors = parseOptionalJsonArray(
    boundaryLayerTargetSurfaceSelectors,
    "Boundary-layer surface selectors",
  );
  if (!surfaceSelectors.ok) return { error: surfaceSelectors.error };
  applyOptionalJsonArray(
    value,
    "boundary_layer_target_surface_selectors",
    surfaceSelectors.value,
  );
  const curveSelectors = parseOptionalJsonArray(
    boundaryLayerTargetCurveSelectors,
    "Boundary-layer curve selectors",
  );
  if (!curveSelectors.ok) return { error: curveSelectors.error };
  applyOptionalJsonArray(
    value,
    "boundary_layer_target_curve_selectors",
    curveSelectors.value,
  );
  const manualBox = applyManualBoxSizeField(value, {
    enabled: manualBoxSizeFieldEnabled,
    source: manualBoxSizeFieldSource,
    vIn: manualBoxSizeFieldVIn,
    vOut: manualBoxSizeFieldVOut,
    xMax: manualBoxSizeFieldXMax,
    xMin: manualBoxSizeFieldXMin,
    yMax: manualBoxSizeFieldYMax,
    yMin: manualBoxSizeFieldYMin,
    zMax: manualBoxSizeFieldZMax,
    zMin: manualBoxSizeFieldZMin,
  });
  if (!manualBox.ok) return { error: manualBox.error };
  const coreRelaxation = applyObjectCoreRelaxationSizeField(value, {
    edgeDistance: coreRelaxationEdgeDistance,
    edgeMaximumElementSize: coreRelaxationEdgeMaximumElementSize,
    enabled: coreRelaxationEnabled,
    geometryName: coreRelaxationGeometryName,
    maximumElementSize: coreRelaxationMaximumElementSize,
    samplingEdge: coreRelaxationSamplingEdge,
    samplingSurface: coreRelaxationSamplingSurface,
    surfaceDistance: coreRelaxationSurfaceDistance,
    surfaceMaximumElementSize: coreRelaxationSurfaceMaximumElementSize,
  });
  if (!coreRelaxation.ok) return { error: coreRelaxation.error };

  return { request: { config: value } };
}

function parseConfig(
  configText: string,
): { ok: true; value: JsonObject } | { error: string; ok: false } {
  try {
    const parsed = JSON.parse(configText || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "Object mesh policy config must be a JSON object.",
        ok: false,
      };
    }
    return { ok: true, value: parsed as JsonObject };
  } catch {
    return {
      error: "Object mesh policy config must be a JSON object.",
      ok: false,
    };
  }
}

function draftRecordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (key === "configText") {
      if (!jsonTextEquivalent(left[key], right[key])) return false;
    } else if (!draftValueEquivalent(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function jsonTextEquivalent(left: unknown, right: unknown): boolean {
  const leftParsed = parseConfig(typeof left === "string" ? left : "");
  const rightParsed = parseConfig(typeof right === "string" ? right : "");
  if (!leftParsed.ok || !rightParsed.ok) return Object.is(left, right);
  return normalizedJsonValue(leftParsed.value) === normalizedJsonValue(rightParsed.value);
}

function normalizedJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(normalizedJsonValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${normalizedJsonValue(nested)}`)
      .join(",")}}`;
  }
  const numeric = finiteNumericValue(value);
  return numeric !== null ? `number:${numeric}` : JSON.stringify(value);
}

function draftValueEquivalent(left: unknown, right: unknown): boolean {
  const leftNumber = finiteNumericValue(left);
  const rightNumber = finiteNumericValue(right);
  if (leftNumber !== null && rightNumber !== null) {
    return Object.is(leftNumber, rightNumber);
  }
  return Object.is(left, right);
}

function finiteNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ManualBoxSizeFieldDraft {
  enabled: boolean;
  source: string;
  vIn: string;
  vOut: string;
  xMax: string;
  xMin: string;
  yMax: string;
  yMin: string;
  zMax: string;
  zMin: string;
}

interface ObjectCoreRelaxationSizeFieldDraft {
  edgeDistance: string;
  edgeMaximumElementSize: string;
  enabled: boolean;
  geometryName: string;
  maximumElementSize: string;
  samplingEdge: string;
  samplingSurface: string;
  surfaceDistance: string;
  surfaceMaximumElementSize: string;
}

function emptyManualBoxSizeField(): ManualBoxSizeFieldDraft {
  return {
    enabled: false,
    source: "",
    vIn: "",
    vOut: "",
    xMax: "",
    xMin: "",
    yMax: "",
    yMin: "",
    zMax: "",
    zMin: "",
  };
}

function emptyObjectCoreRelaxationSizeField(): ObjectCoreRelaxationSizeFieldDraft {
  return {
    edgeDistance: "",
    edgeMaximumElementSize: "",
    enabled: false,
    geometryName: "",
    maximumElementSize: "",
    samplingEdge: "",
    samplingSurface: "",
    surfaceDistance: "",
    surfaceMaximumElementSize: "",
  };
}

function readManualBoxSizeField(value: unknown): ManualBoxSizeFieldDraft {
  if (!Array.isArray(value)) return emptyManualBoxSizeField();
  const boxes: Record<string, unknown>[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record?.kind === "Box" && asRecord(record.params) !== null) {
      boxes.push(record);
    }
  }
  const marked = boxes.find(
    (entry) => sizeFieldSource(entry) === OBJECT_POLICY_MANUAL_BOX_SOURCE,
  );
  const unmarked =
    marked === undefined && boxes.length === 1 && sizeFieldSource(boxes[0]) === null
      ? boxes[0]
      : undefined;
  const field = marked ?? unmarked;
  if (!field) return emptyManualBoxSizeField();
  const params = asRecord(field.params);
  if (!params) return emptyManualBoxSizeField();

  return {
    enabled: true,
    source:
      marked === undefined
        ? UNMARKED_MANUAL_BOX_SOURCE
        : OBJECT_POLICY_MANUAL_BOX_SOURCE,
    vIn: readNumberText(params.VIn),
    vOut: readNumberText(params.VOut),
    xMax: readNumberText(params.XMax),
    xMin: readNumberText(params.XMin),
    yMax: readNumberText(params.YMax),
    yMin: readNumberText(params.YMin),
    zMax: readNumberText(params.ZMax),
    zMin: readNumberText(params.ZMin),
  };
}

function readObjectCoreRelaxationSizeField(
  value: unknown,
): ObjectCoreRelaxationSizeFieldDraft {
  if (!Array.isArray(value)) return emptyObjectCoreRelaxationSizeField();
  for (const entry of value) {
    const record = asRecord(entry);
    if (record?.kind !== OBJECT_CORE_RELAXATION_KIND) continue;
    const params = asRecord(record.params);
    if (!params) return emptyObjectCoreRelaxationSizeField();
    return {
      edgeDistance: readNumberText(params.edge_distance),
      edgeMaximumElementSize: readNumberText(params.edge_maximum_element_size),
      enabled: true,
      geometryName: readStringText(params.GeometryName),
      maximumElementSize: readNumberText(params.core_maximum_element_size),
      samplingEdge: readNumberText(params.sampling_edge) || "40",
      samplingSurface: readNumberText(params.sampling_surface) || "20",
      surfaceDistance: readNumberText(params.surface_distance),
      surfaceMaximumElementSize: readNumberText(
        params.surface_maximum_element_size,
      ),
    };
  }
  return emptyObjectCoreRelaxationSizeField();
}

function applyManualBoxSizeField(
  config: JsonObject,
  draft: ManualBoxSizeFieldDraft,
): { ok: true } | { error: string; ok: false } {
  const rawFields = config.size_fields;
  if (
    (draft.enabled || draft.source) &&
    rawFields !== undefined &&
    rawFields !== null &&
    !Array.isArray(rawFields)
  ) {
    return {
      error: "Object mesh policy size_fields must be an array.",
      ok: false,
    };
  }

  const fields = Array.isArray(rawFields) ? rawFields : [];
  const nextFields = fields.filter(
    (entry) => !isEditableManualBoxSizeField(entry, draft.source),
  );
  if (draft.enabled) {
    const parsed = parseManualBoxSizeField(draft);
    if (!parsed.ok) return parsed;
    nextFields.push({
      kind: "Box",
      source: OBJECT_POLICY_MANUAL_BOX_SOURCE,
      params: parsed.params,
    });
  }

  if (nextFields.length === 0) {
    delete config.size_fields;
    return { ok: true };
  }

  config.size_fields = nextFields as JsonValue[];
  return { ok: true };
}

function applyObjectCoreRelaxationSizeField(
  config: JsonObject,
  draft: ObjectCoreRelaxationSizeFieldDraft,
): { ok: true } | { error: string; ok: false } {
  const rawFields = config.size_fields;
  if (
    draft.enabled &&
    rawFields !== undefined &&
    rawFields !== null &&
    !Array.isArray(rawFields)
  ) {
    return {
      error: "Object mesh policy size_fields must be an array.",
      ok: false,
    };
  }

  const fields = Array.isArray(rawFields) ? rawFields : [];
  const nextFields = fields.filter((entry) => {
    const field = asRecord(entry);
    return field?.kind !== OBJECT_CORE_RELAXATION_KIND;
  });
  if (draft.enabled) {
    const parsed = parseObjectCoreRelaxationSizeField(draft);
    if (!parsed.ok) return parsed;
    nextFields.push({
      kind: OBJECT_CORE_RELAXATION_KIND,
      params: parsed.params,
    });
  }

  if (nextFields.length === 0) {
    delete config.size_fields;
    return { ok: true };
  }

  config.size_fields = nextFields as JsonValue[];
  return { ok: true };
}

function parseManualBoxSizeField(
  draft: ManualBoxSizeFieldDraft,
):
  | { ok: true; params: JsonObject }
  | { error: string; ok: false } {
  const vIn = parseRequiredPositiveNumber(draft.vIn, "Box VIn");
  if (!vIn.ok) return vIn;
  const vOut = parseRequiredPositiveNumber(draft.vOut, "Box VOut");
  if (!vOut.ok) return vOut;
  const xMin = parseRequiredFiniteNumber(draft.xMin, "Box X min");
  if (!xMin.ok) return xMin;
  const xMax = parseRequiredFiniteNumber(draft.xMax, "Box X max");
  if (!xMax.ok) return xMax;
  const yMin = parseRequiredFiniteNumber(draft.yMin, "Box Y min");
  if (!yMin.ok) return yMin;
  const yMax = parseRequiredFiniteNumber(draft.yMax, "Box Y max");
  if (!yMax.ok) return yMax;
  const zMin = parseRequiredFiniteNumber(draft.zMin, "Box Z min");
  if (!zMin.ok) return zMin;
  const zMax = parseRequiredFiniteNumber(draft.zMax, "Box Z max");
  if (!zMax.ok) return zMax;

  if (xMax.value <= xMin.value) {
    return { error: "Box X max must be greater than Box X min.", ok: false };
  }
  if (yMax.value <= yMin.value) {
    return { error: "Box Y max must be greater than Box Y min.", ok: false };
  }
  if (zMax.value <= zMin.value) {
    return { error: "Box Z max must be greater than Box Z min.", ok: false };
  }

  return {
    ok: true,
    params: {
      VIn: vIn.value,
      VOut: vOut.value,
      XMax: xMax.value,
      XMin: xMin.value,
      YMax: yMax.value,
      YMin: yMin.value,
      ZMax: zMax.value,
      ZMin: zMin.value,
    },
  };
}

function parseObjectCoreRelaxationSizeField(
  draft: ObjectCoreRelaxationSizeFieldDraft,
):
  | { ok: true; params: JsonObject }
  | { error: string; ok: false } {
  const geometryName = draft.geometryName.trim();
  if (!geometryName) {
    return { error: "Object core relaxation geometry name is required.", ok: false };
  }

  const core = parseRequiredPositiveNumber(
    draft.maximumElementSize,
    "Core maximum element size",
  );
  if (!core.ok) return core;
  const surface = parseRequiredPositiveNumber(
    draft.surfaceMaximumElementSize,
    "Surface maximum element size",
  );
  if (!surface.ok) return surface;
  if (surface.value > core.value) {
    return {
      error: "Surface maximum element size must be <= core maximum element size.",
      ok: false,
    };
  }
  const surfaceDistance = parseRequiredPositiveNumber(
    draft.surfaceDistance,
    "Surface distance",
  );
  if (!surfaceDistance.ok) return surfaceDistance;
  const samplingSurface = parseSamplingCount(
    draft.samplingSurface,
    "Surface sampling",
  );
  if (!samplingSurface.ok) return samplingSurface;
  const samplingEdge = parseSamplingCount(draft.samplingEdge, "Edge sampling");
  if (!samplingEdge.ok) return samplingEdge;

  const params: JsonObject = {
    GeometryName: geometryName,
    core_maximum_element_size: core.value,
    sampling_edge: samplingEdge.value,
    sampling_surface: samplingSurface.value,
    surface_distance: surfaceDistance.value,
    surface_maximum_element_size: surface.value,
  };

  const edgeText = draft.edgeMaximumElementSize.trim();
  const edgeDistanceText = draft.edgeDistance.trim();
  if (edgeText || edgeDistanceText) {
    const edge = parseRequiredPositiveNumber(
      draft.edgeMaximumElementSize,
      "Edge maximum element size",
    );
    if (!edge.ok) return edge;
    if (edge.value > surface.value) {
      return {
        error:
          "Edge maximum element size must be <= surface maximum element size.",
        ok: false,
      };
    }
    const edgeDistance = parseRequiredPositiveNumber(
      draft.edgeDistance,
      "Edge distance",
    );
    if (!edgeDistance.ok) return edgeDistance;
    params.edge_distance = edgeDistance.value;
    params.edge_maximum_element_size = edge.value;
  }

  return {
    ok: true,
    params,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sizeFieldSource(field: Record<string, unknown>): string | null {
  if (typeof field.source === "string" && field.source.trim()) {
    return field.source.trim();
  }
  const params = asRecord(field.params);
  const source = params?.Source;
  return typeof source === "string" && source.trim() ? source.trim() : null;
}

function isEditableManualBoxSizeField(
  value: unknown,
  draftSource: string,
): boolean {
  const field = asRecord(value);
  if (!field || field.kind !== "Box") return false;
  const source = sizeFieldSource(field);
  if (source === OBJECT_POLICY_MANUAL_BOX_SOURCE) return true;
  return draftSource === UNMARKED_MANUAL_BOX_SOURCE && source === null;
}

function isFiniteNumberLike(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Number(trimmed));
}

function readNumberText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return Number.isFinite(Number(trimmed)) ? trimmed : "";
  }
  return "";
}

function readTransitionDistanceText(value: unknown): string {
  if (value === "airbox_boundary") return "airbox_boundary";
  return readNumberText(value);
}

function readStringText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBooleanText(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "";
}

function readIntegerListText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const integers = value.filter(
    (entry): entry is number => Number.isInteger(entry),
  );
  return integers.length === value.length ? integers.join(", ") : "";
}

function readJsonArrayText(value: unknown): string {
  return Array.isArray(value) ? JSON.stringify(value, null, 2) : "";
}

function parsePositiveNumber(
  value: string,
  label: string,
  integer = false,
  allowZero = false,
): { ok: true; value: number | null } | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };

  const parsed = Number(trimmed);
  const tooSmall = allowZero ? parsed < 0 : parsed <= 0;
  if (!Number.isFinite(parsed) || tooSmall) {
    return {
      error: allowZero
        ? `${label} must be greater than or equal to 0.`
        : `${label} must be greater than 0.`,
      ok: false,
    };
  }
  if (integer && !Number.isInteger(parsed)) {
    return {
      error: `${label} must be an integer.`,
      ok: false,
    };
  }

  return { ok: true, value: parsed };
}

function parseTransitionDistance(
  value: string,
  label: string,
):
  | { ok: true; value: "airbox_boundary" | number | null }
  | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed === "airbox_boundary") {
    return { ok: true, value: "airbox_boundary" };
  }
  const parsed = parsePositiveNumber(trimmed, label);
  if (!parsed.ok) {
    return {
      error: `${label} must be a positive number or airbox_boundary.`,
      ok: false,
    };
  }
  return { ok: true, value: parsed.value };
}

function parseRequiredPositiveNumber(
  value: string,
  label: string,
): { ok: true; value: number } | { error: string; ok: false } {
  const parsed = parsePositiveNumber(value, label);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) {
    return { error: `${label} is required.`, ok: false };
  }
  return { ok: true, value: parsed.value };
}

function parseSamplingCount(
  value: string,
  label: string,
): { ok: true; value: number } | { error: string; ok: false } {
  const parsed = parseRequiredPositiveNumber(value, label);
  if (!parsed.ok) return parsed;
  if (!Number.isInteger(parsed.value)) {
    return { error: `${label} must be an integer.`, ok: false };
  }
  if (parsed.value < 2) {
    return { error: `${label} must be >= 2.`, ok: false };
  }
  return { ok: true, value: parsed.value };
}

function parseFiniteNumber(
  value: string,
  label: string,
): { ok: true; value: number | null } | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      error: `${label} must be a finite number.`,
      ok: false,
    };
  }

  return { ok: true, value: parsed };
}

function parseRequiredFiniteNumber(
  value: string,
  label: string,
): { ok: true; value: number } | { error: string; ok: false } {
  const parsed = parseFiniteNumber(value, label);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) {
    return { error: `${label} is required.`, ok: false };
  }
  return { ok: true, value: parsed.value };
}

function parseIntegerList(
  value: string,
  label: string,
): { ok: true; value: number[] | null } | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  const values = trimmed.split(",").map((part) => part.trim());
  const parsed = values.map((part) => Number(part));
  if (parsed.some((entry) => !Number.isInteger(entry) || entry <= 0)) {
    return { error: `${label} must be a comma-separated list of positive integers.`, ok: false };
  }
  return { ok: true, value: parsed };
}

function parseOptionalJsonArray(
  value: string,
  label: string,
): { ok: true; value: JsonValue[] | null } | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return { error: `${label} must be a JSON array.`, ok: false };
    }
    return { ok: true, value: parsed as JsonValue[] };
  } catch {
    return { error: `${label} must be a JSON array.`, ok: false };
  }
}

function applyOptionalNumber(
  config: JsonObject,
  key: string,
  value: number | null,
): void {
  if (value === null) {
    delete config[key];
    return;
  }

  config[key] = value;
}

function applyOptionalTransitionDistance(
  config: JsonObject,
  key: string,
  value: "airbox_boundary" | number | null,
): void {
  if (value === null) {
    delete config[key];
    return;
  }

  config[key] = value;
}

function applyOptionalList(
  config: JsonObject,
  key: string,
  value: number[] | null,
): void {
  if (value === null) {
    delete config[key];
    return;
  }

  config[key] = value;
}

function applyOptionalJsonArray(
  config: JsonObject,
  key: string,
  value: JsonValue[] | null,
): void {
  if (value === null) {
    delete config[key];
    return;
  }

  config[key] = value;
}

function applyOptionalString(
  config: JsonObject,
  key: string,
  value: string,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    delete config[key];
    return;
  }

  config[key] = trimmed;
}

function applyOptionalBoolean(
  config: JsonObject,
  key: string,
  value: string,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    delete config[key];
    return;
  }

  config[key] = trimmed === "true";
}
