import type {
  JsonObject,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
} from "@/kernel/api/apiTypes";
import { defaultObjectMeshPolicyResource } from "@/kernel/resources/geometryLifecycleResources";

export { defaultObjectMeshPolicyResource };

export interface ObjectMeshPolicyDraft {
  cornerExtent: string;
  cornerMaximumElementSize: string;
  configText: string;
  curvatureFactor: string;
  edgeMaximumElementSize: string;
  edgeThickness: string;
  interfaceMaximumElementSize: string;
  interfaceThickness: string;
  maximumElementGrowthRate: string;
  maximumElementSize: string;
  meshStrategy: string;
  minimumElementSize: string;
  narrowRegionResolution: string;
  order: string;
  present: boolean;
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

  return {
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
    maximumElementGrowthRate: readNumberText(
      config.maximum_element_growth_rate ?? config.growth_rate,
    ),
    maximumElementSize: readNumberText(config.maximum_element_size),
    meshStrategy: readStringText(config.mesh_strategy),
    minimumElementSize: readNumberText(config.minimum_element_size),
    narrowRegionResolution: readNumberText(config.narrow_region_resolution),
    order: readNumberText(config.order),
    present: resource.config !== null && resource.config !== undefined,
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
  configText,
  curvatureFactor,
  edgeMaximumElementSize,
  edgeThickness,
  interfaceMaximumElementSize,
  interfaceThickness,
  maximumElementGrowthRate,
  maximumElementSize,
  meshStrategy,
  minimumElementSize,
  narrowRegionResolution,
  order,
  present,
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
