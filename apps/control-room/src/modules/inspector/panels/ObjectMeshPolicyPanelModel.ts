import type {
  JsonObject,
  JsonValue,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
} from "@/kernel/api/apiTypes";
import { defaultObjectMeshPolicyResource } from "@/kernel/resources/geometryLifecycleResources";

export { defaultObjectMeshPolicyResource };

const OBJECT_POLICY_MANUAL_BOX_SOURCE = "object_policy_manual_box";
const UNMARKED_MANUAL_BOX_SOURCE = "unmarked_manual_box";

export interface ObjectMeshPolicyDraft {
  algorithm2d: string;
  algorithm3d: string;
  boundaryLayerCount: string;
  boundaryLayerStretching: string;
  boundaryLayerTargetCurveTags: string;
  boundaryLayerTargetSurfaceTags: string;
  boundaryLayerThickness: string;
  computeQuality: string;
  cornerExtent: string;
  cornerMaximumElementSize: string;
  configText: string;
  curvatureFactor: string;
  edgeMaximumElementSize: string;
  edgeThickness: string;
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
  narrowRegionResolution: string;
  order: string;
  optimize: string;
  optimizeIterations: string;
  perElementQuality: string;
  present: boolean;
  smoothingSteps: string;
  sweepFaceMeshing: string;
  throughThicknessDistribution: string;
  throughThicknessElementRatio: string;
  throughThicknessElements: string;
  throughThicknessSymmetric: string;
  transitionDistance: string;
  transitionGrowth: string;
}

export function formatObjectMeshPolicyConfig(
  config: JsonObject | null | undefined,
): string {
  if (!config || Object.keys(config).length === 0) return "{}";
  return JSON.stringify(config, null, 2);
}

export function draftFromObjectMeshPolicyResource(
  resource: MeshObjectConfigResource,
): ObjectMeshPolicyDraft {
  const config = resource.config ?? {};
  const manualBox = readManualBoxSizeField(config.size_fields);

  return {
    algorithm2d: readNumberText(config.algorithm_2d),
    algorithm3d: readNumberText(config.algorithm_3d),
    boundaryLayerCount: readNumberText(config.boundary_layer_count),
    boundaryLayerStretching: readNumberText(config.boundary_layer_stretching),
    boundaryLayerTargetCurveTags: readIntegerListText(
      config.boundary_layer_target_curve_tags,
    ),
    boundaryLayerTargetSurfaceTags: readIntegerListText(
      config.boundary_layer_target_surface_tags,
    ),
    boundaryLayerThickness: readNumberText(config.boundary_layer_thickness),
    computeQuality: readBooleanText(config.compute_quality),
    cornerExtent: readNumberText(config.corner_extent),
    cornerMaximumElementSize: readNumberText(config.corner_maximum_element_size),
    configText: formatObjectMeshPolicyConfig(resource.config),
    curvatureFactor: readNumberText(config.curvature_factor),
    edgeMaximumElementSize: readNumberText(config.edge_maximum_element_size),
    edgeThickness: readNumberText(config.edge_thickness),
    interfaceMaximumElementSize: readNumberText(
      config.interface_maximum_element_size,
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
    narrowRegionResolution: readNumberText(config.narrow_region_resolution),
    order: readNumberText(config.order),
    optimize: readStringText(config.optimize),
    optimizeIterations: readNumberText(config.optimize_iterations),
    perElementQuality: readBooleanText(config.per_element_quality),
    present: resource.config !== null && resource.config !== undefined,
    smoothingSteps: readNumberText(config.smoothing_steps),
    sweepFaceMeshing: readStringText(config.sweep_face_meshing),
    throughThicknessDistribution: readStringText(
      config.through_thickness_distribution,
    ),
    throughThicknessElementRatio: readNumberText(
      config.through_thickness_element_ratio,
    ),
    throughThicknessElements: readNumberText(config.through_thickness_elements),
    throughThicknessSymmetric: readBooleanText(config.through_thickness_symmetric),
    transitionDistance: readNumberText(config.transition_distance),
    transitionGrowth: readNumberText(config.transition_growth),
  };
}

export function draftKeyForObjectMeshPolicyResource(
  objectId: string | null | undefined,
  resource: MeshObjectConfigResource,
): string {
  return [
    objectId ?? "",
    resource.revision,
    formatObjectMeshPolicyConfig(resource.config),
  ].join(":");
}

export function buildObjectMeshPolicyReplaceRequest({
  cornerExtent,
  cornerMaximumElementSize,
  algorithm2d,
  algorithm3d,
  boundaryLayerCount,
  boundaryLayerStretching,
  boundaryLayerTargetCurveTags,
  boundaryLayerTargetSurfaceTags,
  boundaryLayerThickness,
  computeQuality,
  configText,
  curvatureFactor,
  edgeMaximumElementSize,
  edgeThickness,
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
  narrowRegionResolution,
  order,
  optimize,
  optimizeIterations,
  perElementQuality,
  present,
  smoothingSteps,
  sweepFaceMeshing,
  throughThicknessDistribution,
  throughThicknessElementRatio,
  throughThicknessElements,
  throughThicknessSymmetric,
  transitionDistance,
  transitionGrowth,
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
    [
      "interface_maximum_element_size",
      interfaceMaximumElementSize,
      "Interface maximum element size",
    ],
    ["interface_thickness", interfaceThickness, "Interface thickness"],
    ["transition_distance", transitionDistance, "Transition distance"],
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

  for (const [key, text, label, integer] of numericFields) {
    const parsed = parsePositiveNumber(text, label, integer);
    if (!parsed.ok) return { error: parsed.error };
    applyOptionalNumber(value, key, parsed.value);
  }

  applyOptionalString(value, "mesh_strategy", meshStrategy);
  applyOptionalString(value, "optimize", optimize);
  applyOptionalString(
    value,
    "through_thickness_distribution",
    throughThicknessDistribution,
  );
  applyOptionalString(value, "sweep_face_meshing", sweepFaceMeshing);
  applyOptionalBoolean(
    value,
    "through_thickness_symmetric",
    throughThicknessSymmetric,
  );
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

function parsePositiveNumber(
  value: string,
  label: string,
  integer = false,
): { ok: true; value: number | null } | { error: string; ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      error: `${label} must be greater than 0.`,
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
