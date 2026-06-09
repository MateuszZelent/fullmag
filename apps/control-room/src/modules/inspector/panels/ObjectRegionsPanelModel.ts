import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type {
  CouplingListResource,
  MaterialParameterFieldListResource,
  RegionDiagnosticsResource,
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

export type RegionEditShapeKind = "box" | "cylinder" | "sphere";
export type RegionEditRealizationPolicy = "inherit" | "conformal" | "project";

interface JsonRecord {
  [key: string]: unknown;
}

export interface RegionMeshPolicyDraft {
  enabled: boolean;
  maximumElementSize: number;
  minimumElementSize: number;
  order: number;
  transitionDistance: number;
}

export interface RegionShapeDraft {
  axis: [number, number, number];
  center: [number, number, number];
  height: number;
  kind: RegionEditShapeKind;
  radius: number;
  size: [number, number, number];
}

export type RegionMaterialParameter = "aex" | "ms" | "alpha" | "ku1";
export type RegionMaterialConflictPolicy = "error" | "higher_priority_wins";

export interface RegionMaterialOverrideDraft {
  conflictPolicy: RegionMaterialConflictPolicy;
  parameter: RegionMaterialParameter;
  priority: number;
  unit: string;
  value: number;
}

export interface ObjectRegionDiagnosticItem {
  capabilityGate: string | null;
  code: string;
  diagnosticId: string;
  message: string;
  realizationStatus: string | null;
  severity: string;
}

export interface RegionCouplingDependency {
  couplingId: string;
  endpointRole: "source" | "target";
  kind: string;
  status: string;
}

export interface ObjectRegionPanelModel {
  diagnosticCount: number;
  diagnostics: ObjectRegionDiagnosticItem[];
  enabled: boolean;
  effectiveMagnetizationRef: string;
  errorCount: number;
  frame: components["schemas"]["SceneRegionFrame"];
  magnetizationRef: string;
  materialRef: string;
  materialFieldCount: number;
  materialOverrideCount: number;
  materialOverrides: RegionMaterialOverrideDraft[];
  meshPolicy: RegionMeshPolicyDraft;
  mode: "committed" | "missing";
  objectId: string;
  ownerBounds: RegionOwnerBounds | null;
  priority: number | null;
  realizationPolicy: string | null;
  realizationStatus: string | null;
  regionId: string;
  regionMagnetizationRef: string;
  regionName: string;
  revision: number | null;
  shape: RegionShapeDraft;
  source: string;
  textureAssignment: "inherited" | "override" | "unassigned";
  textureOverrideKind: string;
  warningCount: number;
}

export interface ObjectRegionDraft {
  frame: components["schemas"]["SceneRegionFrame"];
  meshPolicy: RegionMeshPolicyDraft;
  materialOverrides: RegionMaterialOverrideDraft[];
  enabled: boolean;
  name: string;
  ownerBounds: RegionOwnerBounds | null;
  priority: number;
  realizationPolicy: RegionEditRealizationPolicy;
  shape: RegionShapeDraft;
}

export interface RegionOwnerBounds {
  center: [number, number, number];
  size: [number, number, number];
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function endpointReferencesRegion(
  endpoint: unknown,
  objectId: string,
  regionId: string,
): boolean {
  const record = asRecord(endpoint);
  return (
    asString(record?.kind) === "region" &&
    asString(record?.object) === objectId &&
    asString(record?.region_id) === regionId
  );
}

export function resolveRegionCouplingDependencies(
  objectId: string,
  regionId: string,
  couplings: CouplingListResource | null | undefined,
): RegionCouplingDependency[] {
  const dependencies: RegionCouplingDependency[] = [];
  for (const coupling of couplings?.couplings ?? []) {
    if (!coupling.enabled) continue;
    if (endpointReferencesRegion(coupling.source, objectId, regionId)) {
      dependencies.push({
        couplingId: coupling.coupling_id,
        endpointRole: "source",
        kind: coupling.coupling_kind,
        status: coupling.realization_status ?? "authored",
      });
    }
    if (endpointReferencesRegion(coupling.target, objectId, regionId)) {
      dependencies.push({
        couplingId: coupling.coupling_id,
        endpointRole: "target",
        kind: coupling.coupling_kind,
        status: coupling.realization_status ?? "authored",
      });
    }
  }
  return dependencies;
}

function numberIsPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function trimExponential(value: string): string {
  return value
    .replace(/(\.\d*?[1-9])0+e/, "$1e")
    .replace(/\.0+e/, "e")
    .replace(/e\+/, "e")
    .replace(/e(-?)0+(\d)/, "e$1$2");
}

export function formatRegionPhysicalScalar(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs > 0 && (abs < 1e-3 || abs >= 1e6)) {
    return trimExponential(value.toExponential(6));
  }
  return String(value);
}

export function parseRegionPhysicalScalar(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(
    /^([+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?)\s*([^\s]+)?$/,
  );
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  const unit = (match[2] ?? "").replace("μ", "u");
  const factor = physicalScalarUnitFactor(unit);
  return factor === null ? null : parsed * factor;
}

function physicalScalarUnitFactor(unit: string): number | null {
  if (unit.length === 0) return 1;
  const normalized = unit.toLowerCase();
  if (normalized === "m") return 1;
  if (normalized === "nm") return 1e-9;
  if (normalized === "um") return 1e-6;
  if (normalized === "mm") return 1e-3;
  if (normalized === "a/m") return 1;
  if (normalized === "ka/m") return 1e3;
  if (normalized === "ma/m") return 1e6;
  if (normalized === "j/m") return 1;
  if (normalized === "pj/m") return 1e-12;
  if (normalized === "nj/m") return 1e-9;
  return null;
}

export function ownerBoundsForObject(object: JsonRecord | null): RegionOwnerBounds | null {
  const geometry = asRecord(object?.geometry);
  const min = finiteVector3(geometry?.bounds_min ?? object?.bounds_min);
  const max = finiteVector3(geometry?.bounds_max ?? object?.bounds_max);
  if (!min || !max) return ownerBoundsFromGeometryParams(geometry);
  const size: [number, number, number] = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
  if (size.some((entry) => entry <= 0 || !Number.isFinite(entry))) return null;
  return {
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ],
    size,
  };
}

function ownerBoundsFromGeometryParams(geometry: JsonRecord | null): RegionOwnerBounds | null {
  const params = asRecord(geometry?.geometry_params);
  const kind = asString(geometry?.geometry_kind);
  const center = finiteVector3(params?.center) ?? [0, 0, 0];
  let size: [number, number, number] | null = null;
  if (kind === "Box") {
    size = finiteVector3(params?.size);
  } else if (kind === "Cylinder") {
    const radius = asNumber(params?.radius);
    const height = asNumber(params?.height);
    if (radius && height) {
      size = [radius * 2, radius * 2, height];
    }
  } else if (kind === "ArchWaveguide") {
    const length = asNumber(params?.length);
    const width = asNumber(params?.width);
    const height = asNumber(params?.height);
    if (length && width && height) {
      size = [length, width, height];
    }
  }
  if (!size || size.some((entry) => entry <= 0 || !Number.isFinite(entry))) {
    return null;
  }
  return { center, size };
}

function finiteVector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? [value[0], value[1], value[2]]
    : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function halfExtentsForShape(
  shape: RegionShapeDraft,
  ownerBounds: RegionOwnerBounds,
): [number, number, number] {
  if (shape.kind === "box") {
    return [
      Math.min(Math.max(shape.size[0], 0), ownerBounds.size[0]) / 2,
      Math.min(Math.max(shape.size[1], 0), ownerBounds.size[1]) / 2,
      Math.min(Math.max(shape.size[2], 0), ownerBounds.size[2]) / 2,
    ];
  }
  if (shape.kind === "sphere") {
    const radius = Math.min(
      Math.max(shape.radius, 0),
      ownerBounds.size[0] / 2,
      ownerBounds.size[1] / 2,
      ownerBounds.size[2] / 2,
    );
    return [radius, radius, radius];
  }

  return clampCylinderDimensions(shape, ownerBounds).halfExtents;
}

function normalizedAxis(
  axis: [number, number, number],
): [number, number, number] {
  const norm = Math.hypot(axis[0], axis[1], axis[2]);
  return norm > 1e-15
    ? [axis[0] / norm, axis[1] / norm, axis[2] / norm]
    : [0, 0, 1];
}

function clampCylinderDimensions(
  shape: RegionShapeDraft,
  ownerBounds: RegionOwnerBounds,
): {
  halfExtents: [number, number, number];
  height: number;
  radius: number;
} {
  const axis = normalizedAxis(shape.axis).map(Math.abs) as [
    number,
    number,
    number,
  ];
  const ownerHalf = ownerBounds.size.map((value) => value * 0.5) as [
    number,
    number,
    number,
  ];
  let halfHeight = Math.max(shape.height, 0) * 0.5;
  for (let index = 0; index < 3; index += 1) {
    if (axis[index] > 1e-15) {
      halfHeight = Math.min(halfHeight, ownerHalf[index] / axis[index]);
    }
  }

  let radius = Math.max(shape.radius, 0);
  for (let index = 0; index < 3; index += 1) {
    const radialFactor = Math.sqrt(Math.max(0, 1 - axis[index] ** 2));
    if (radialFactor > 1e-15) {
      const available = Math.max(0, ownerHalf[index] - axis[index] * halfHeight);
      radius = Math.min(radius, available / radialFactor);
    }
  }

  return {
    halfExtents: [0, 1, 2].map(
      (index) =>
        axis[index] * halfHeight +
        radius * Math.sqrt(Math.max(0, 1 - axis[index] ** 2)),
    ) as [number, number, number],
    height: halfHeight * 2,
    radius,
  };
}

function clampCenterToOwnerBounds(
  center: [number, number, number],
  halfExtents: [number, number, number],
  ownerBounds: RegionOwnerBounds,
): [number, number, number] {
  return center.map((value, axis) => {
    const min = ownerBounds.center[axis] - ownerBounds.size[axis] / 2 + halfExtents[axis];
    const max = ownerBounds.center[axis] + ownerBounds.size[axis] / 2 - halfExtents[axis];
    return min <= max ? clamp(value, min, max) : ownerBounds.center[axis];
  }) as [number, number, number];
}

export function clampObjectRegionDraftShapeToOwnerBounds(
  shape: RegionShapeDraft,
  ownerBounds: RegionOwnerBounds | null,
  frame = "object",
): RegionShapeDraft {
  if (!ownerBounds || frame !== "object") return shape;
  const halfExtents = halfExtentsForShape(shape, ownerBounds);
  const center = clampCenterToOwnerBounds(shape.center, halfExtents, ownerBounds);

  if (shape.kind === "box") {
    return {
      ...shape,
      center,
      size: [
        halfExtents[0] * 2,
        halfExtents[1] * 2,
        halfExtents[2] * 2,
      ],
    };
  }
  if (shape.kind === "sphere") {
    return {
      ...shape,
      center,
      radius: halfExtents[0],
    };
  }

  const cylinder = clampCylinderDimensions(shape, ownerBounds);
  return {
    ...shape,
    center,
    height: cylinder.height,
    radius: cylinder.radius,
  };
}

function normalizeRealizationPolicy(value: string | null): RegionEditRealizationPolicy {
  return value === "conformal" || value === "project" ? value : "inherit";
}

function normalizeMaterialParameter(value: string | null): RegionMaterialParameter {
  const lc = value?.toLowerCase();
  if (lc === "aex") return "aex";
  if (lc === "alpha") return "alpha";
  if (lc === "ku1") return "ku1";
  return "ms";
}

function normalizeConflictPolicy(value: string | null): RegionMaterialConflictPolicy {
  return value === "higher_priority_wins" || value === "override"
    ? "higher_priority_wins"
    : "error";
}

function resolveShapeDraft(region: RegionListResource["regions"][number] | null): RegionShapeDraft {
  const shape = region?.shape;
  const kind = shape?.kind;
  const resolvedKind: RegionEditShapeKind =
    kind === "cylinder" || kind === "sphere" ? kind : "box";

  const center: [number, number, number] = shape && "center" in shape && Array.isArray(shape.center) && shape.center.length === 3
    ? (shape.center as [number, number, number])
    : [0, 0, 0];
  const axis: [number, number, number] = shape && "axis" in shape && Array.isArray(shape.axis) && shape.axis.length === 3
    ? (shape.axis as [number, number, number])
    : [0, 0, 1];
  const size: [number, number, number] = shape && "size" in shape && Array.isArray(shape.size) && shape.size.length === 3
    ? (shape.size as [number, number, number])
    : [100e-9, 100e-9, 100e-9];
  const radius = shape && "radius" in shape && typeof shape.radius === "number"
    ? shape.radius
    : 50e-9;
  const height = shape && "height" in shape && typeof shape.height === "number"
    ? shape.height
    : 100e-9;

  return {
    axis,
    center,
    height,
    kind: resolvedKind,
    radius,
    size,
  };
}

function resolveMeshPolicyDraft(region: RegionListResource["regions"][number] | null): RegionMeshPolicyDraft {
  const policy = region?.mesh_policy;
  return {
    enabled: Boolean(policy),
    maximumElementSize: policy?.maximum_element_size ?? 10e-9,
    minimumElementSize: policy?.minimum_element_size ?? 1e-9,
    order: Math.max(1, Math.round(policy?.order ?? 1)),
    transitionDistance: policy?.transition_distance ?? 50e-9,
  };
}

function resolveMaterialOverrideDrafts(
  region: RegionListResource["regions"][number] | null,
): RegionMaterialOverrideDraft[] {
  return (region?.material_overrides ?? []).map((override) => {
    const field = override.value;
    const value = field?.kind === "constant" && typeof field.value === "number" ? field.value : 0;
    const unit = field?.kind === "constant" ? (field.unit ?? "") : "";
    return {
      conflictPolicy: normalizeConflictPolicy(override.conflict_policy ?? null),
      parameter: normalizeMaterialParameter(override.parameter as string),
      priority: Math.round(override.priority ?? region?.priority ?? 0),
      unit: unit || defaultMaterialOverrideUnit(override.parameter as RegionMaterialParameter),
      value: value || defaultMaterialOverrideValue(override.parameter as RegionMaterialParameter),
    };
  });
}

function textureOverrideKind(
  region: RegionListResource["regions"][number] | null,
): string {
  return region?.texture_override?.initial_magnetization?.kind ?? "none";
}

export function defaultMaterialOverrideUnit(
  parameter: RegionMaterialParameter,
): string {
  if (parameter === "aex") return "J/m";
  if (parameter === "alpha") return "";
  if (parameter === "ku1") return "J/m^3";
  return "A/m";
}

export function defaultMaterialOverrideValue(
  parameter: RegionMaterialParameter,
): number {
  if (parameter === "aex") return 1e-11;
  if (parameter === "alpha") return 0.1;
  if (parameter === "ku1") return 0;
  return 800e3;
}

export function defaultMaterialOverrideDraft(
  priority = 0,
): RegionMaterialOverrideDraft {
  return {
    conflictPolicy: "error",
    parameter: "ms",
    priority,
    unit: "A/m",
    value: 800e3,
  };
}

function selectedObjectId(selection: Selection): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
}

function selectedRegionId(selection: Selection): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.regionId ?? null
    : null;
}

function sceneObjectForSelection(
  selection: Selection,
  scene: SceneResource | null,
): { object: JsonRecord | null; objectId: string | null; revision: number | null } {
  const objectId = selectedObjectId(selection);
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;

  return {
    object,
    objectId,
    revision: asNumber(sceneRecord?.revision),
  };
}

function regionForObject(
  selection: Selection,
  objectId: string | null,
  object: JsonRecord | null,
  regions: RegionListResource | null,
): RegionListResource["regions"][number] | null {
  if (!objectId) return null;
  const selectedRegion = selectedRegionId(selection);
  if (selectedRegion) {
    const exact = regions?.regions.find((region) => {
      return (
        region.region_id === selectedRegion &&
        (region.owner_object_id === objectId ||
          region.source_object_ids.includes(objectId))
      );
    });
    if (exact) return exact;
  }
  const objectRegionName = asString(object?.region_name);
  return (
    regions?.regions.find((region) => {
      return (
        region.source_object_ids.includes(objectId) ||
        region.region_id === `region:${objectId}` ||
        (objectRegionName ? region.name === objectRegionName : false)
      );
    }) ?? null
  );
}

function materialFieldCountForRegion(
  objectId: string | null,
  regionId: string | null,
  materialFields: MaterialParameterFieldListResource | null,
): number {
  if (!objectId || !regionId) return 0;
  return (
    materialFields?.fields.filter(
      (field) =>
        field.owner_object_id === objectId &&
        field.source_region_id === regionId,
    ).length ?? 0
  );
}

function diagnosticsForRegion(
  objectId: string | null,
  regionId: string | null,
  regionDiagnostics: RegionDiagnosticsResource | null,
): ObjectRegionDiagnosticItem[] {
  if (!objectId || !regionId) return [];
  return (
    regionDiagnostics?.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.owner_object_id === objectId &&
          diagnostic.region_id === regionId,
      )
      .map((diagnostic) => ({
        capabilityGate: diagnostic.capability_gate ?? null,
        code: diagnostic.code,
        diagnosticId: diagnostic.diagnostic_id,
        message: diagnostic.message,
        realizationStatus: diagnostic.realization_status ?? null,
        severity: diagnostic.severity,
      })) ?? []
  );
}

export function resolveObjectRegionPanelModel(
  selection: Selection,
  scene: SceneResource | null,
  regions: RegionListResource | null,
  materialFields: MaterialParameterFieldListResource | null = null,
  regionDiagnostics: RegionDiagnosticsResource | null = null,
): ObjectRegionPanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);
  const region = regionForObject(selection, objectId, object, regions);
  const ownerBounds = ownerBoundsForObject(object);
  const fallbackName =
    asString(object?.region_name) ?? asString(object?.name) ?? objectId ?? "none";
  const regionId = region?.region_id ?? (objectId ? `region:${objectId}` : "none");
  const materialFieldCount = Math.max(
    region?.material_parameter_fields?.length ?? 0,
    materialFieldCountForRegion(objectId, regionId, materialFields),
  );
  const objectMagnetizationRef = asString(object?.magnetization_ref);
  const regionMagnetizationRef = region?.magnetization_ref ?? null;
  const effectiveMagnetizationRef =
    regionMagnetizationRef ?? objectMagnetizationRef ?? "unassigned";
  const textureAssignment = regionMagnetizationRef
    ? "override"
    : objectMagnetizationRef
      ? "inherited"
      : "unassigned";
  const diagnostics = diagnosticsForRegion(objectId, regionId, regionDiagnostics);
  const warningCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  ).length;
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;

  if (!object || !objectId) {
    return {
      diagnosticCount: 0,
      diagnostics: [],
      enabled: false,
      effectiveMagnetizationRef: "unassigned",
      errorCount: 0,
      frame: "object",
      magnetizationRef: "unassigned",
      materialRef: "unassigned",
      materialFieldCount: 0,
      materialOverrideCount: 0,
      materialOverrides: [],
      meshPolicy: resolveMeshPolicyDraft(null),
      mode: "missing",
      objectId: objectId ?? "none",
      ownerBounds,
      priority: null,
      realizationPolicy: null,
      realizationStatus: null,
      regionId,
      regionMagnetizationRef: "inherits object",
      regionName: fallbackName,
      revision,
      shape: resolveShapeDraft(null),
      source: "missing",
      textureAssignment: "unassigned",
      textureOverrideKind: "none",
      warningCount: 0,
    };
  }

  return {
    diagnosticCount: diagnostics.length,
    diagnostics,
    enabled: region?.enabled ?? true,
    effectiveMagnetizationRef,
    errorCount,
    frame: (region?.frame as components["schemas"]["SceneRegionFrame"]) ?? "object",
    magnetizationRef: region?.magnetization_ref ?? "unassigned",
    materialRef: region?.material_ref ?? asString(object.material_ref) ?? "unassigned",
    materialFieldCount,
    materialOverrideCount: region?.material_overrides?.length ?? 0,
    materialOverrides: resolveMaterialOverrideDrafts(region),
    meshPolicy: resolveMeshPolicyDraft(region),
    mode: "committed",
    objectId,
    ownerBounds,
    priority: region?.priority ?? null,
    realizationPolicy: region?.realization_policy ?? null,
    realizationStatus: region?.realization_status ?? null,
    regionId,
    regionMagnetizationRef: regionMagnetizationRef ?? "inherits object",
    regionName: region?.name ?? fallbackName,
    revision,
    shape: resolveShapeDraft(region),
    source: region?.source ?? "scene-object",
    textureAssignment,
    textureOverrideKind: textureOverrideKind(region),
    warningCount,
  };
}

export function objectRegionDraftFromModel(
  model: ObjectRegionPanelModel,
): ObjectRegionDraft {
  return {
    enabled: model.enabled,
    frame: model.frame,
    materialOverrides: model.materialOverrides.map((override) => ({ ...override })),
    meshPolicy: { ...model.meshPolicy },
    name: model.regionName === "unassigned" ? "" : model.regionName,
    ownerBounds: model.ownerBounds,
    priority: model.priority ?? 0,
    realizationPolicy: normalizeRealizationPolicy(model.realizationPolicy),
    shape: {
      ...model.shape,
      axis: [...model.shape.axis],
      center: [...model.shape.center],
      size: [...model.shape.size],
    },
  };
}

export function objectRegionDraftKey(model: ObjectRegionPanelModel): string {
  return [
    model.objectId,
    model.regionId,
    model.regionName,
    model.enabled ? "enabled" : "disabled",
    model.ownerBounds
      ? [...model.ownerBounds.center, ...model.ownerBounds.size].join(",")
      : "no-owner-bounds",
    model.priority ?? "priority-default",
    model.realizationPolicy ?? "realization-default",
    model.frame,
    model.materialOverrides
      .map((override) =>
        [
          override.parameter,
          override.value,
          override.unit,
          override.priority,
          override.conflictPolicy,
        ].join(","),
      )
      .join("|"),
    model.shape.kind,
    model.shape.center.join(","),
    model.shape.size.join(","),
    model.shape.radius,
    model.shape.height,
    model.shape.axis.join(","),
    model.meshPolicy.enabled ? "mesh-enabled" : "mesh-disabled",
    model.meshPolicy.maximumElementSize,
    model.meshPolicy.minimumElementSize,
    model.meshPolicy.transitionDistance,
    model.meshPolicy.order,
    model.revision ?? "unknown",
  ].join(":");
}

export function objectRegionDraftIdentityKey(
  model: ObjectRegionPanelModel,
): string {
  return [model.mode, model.objectId, model.regionId ?? "unassigned"].join(":");
}

export function validateObjectRegionDraft(draft: ObjectRegionDraft): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length === 0) {
    errors.push("Region name is required.");
  }
  if (!Number.isFinite(draft.priority) || !Number.isInteger(draft.priority)) {
    errors.push("Region priority must be an integer.");
  }
  if (!draft.shape.center.every(Number.isFinite)) {
    errors.push("Shape center must contain finite values.");
  }
  if (draft.shape.kind === "box" && !draft.shape.size.every(numberIsPositive)) {
    errors.push("Box size values must be greater than zero.");
  }
  if (
    (draft.shape.kind === "cylinder" || draft.shape.kind === "sphere") &&
    !numberIsPositive(draft.shape.radius)
  ) {
    errors.push("Radius must be greater than zero.");
  }
  if (draft.shape.kind === "cylinder") {
    if (!numberIsPositive(draft.shape.height)) {
      errors.push("Height must be greater than zero.");
    }
    if (!draft.shape.axis.every(Number.isFinite)) {
      errors.push("Axis must contain finite values.");
    }
    if (draft.shape.axis.every((component) => component === 0)) {
      errors.push("Axis must not be the zero vector.");
    }
  }
  if (draft.meshPolicy.enabled) {
    if (!numberIsPositive(draft.meshPolicy.maximumElementSize)) {
      errors.push("Max element size must be greater than zero.");
    }
    if (!numberIsPositive(draft.meshPolicy.minimumElementSize)) {
      errors.push("Min element size must be greater than zero.");
    }
    if (
      Number.isFinite(draft.meshPolicy.maximumElementSize) &&
      Number.isFinite(draft.meshPolicy.minimumElementSize) &&
      draft.meshPolicy.maximumElementSize < draft.meshPolicy.minimumElementSize
    ) {
      errors.push("Max element size must be greater than or equal to min element size.");
    }
    if (!numberIsPositive(draft.meshPolicy.transitionDistance)) {
      errors.push("Transition distance must be greater than zero.");
    }
    if (
      !Number.isFinite(draft.meshPolicy.order) ||
      !Number.isInteger(draft.meshPolicy.order) ||
      draft.meshPolicy.order < 1
    ) {
      errors.push("Mesh order must be an integer at least 1.");
    }
  }
  for (const override of draft.materialOverrides) {
    if (!Number.isFinite(override.priority) || !Number.isInteger(override.priority)) {
      errors.push(`${override.parameter} override priority must be an integer.`);
    }
    if (!Number.isFinite(override.value)) {
      errors.push(`${override.parameter} override value must be finite.`);
    }
    if (
      override.parameter === "ms" &&
      !numberIsPositive(override.value)
    ) {
      errors.push("Ms override must be greater than zero.");
    }
    if (
      (override.parameter === "aex" ||
        override.parameter === "alpha" ||
        override.parameter === "ku1") &&
      override.value < 0
    ) {
      errors.push(`${override.parameter} override must be non-negative.`);
    }
  }
  return errors;
}

export function buildObjectRegionPatch(
  draft: ObjectRegionDraft,
): components["schemas"]["SceneObjectRegionPatch"] {
  const clampedShape = clampObjectRegionDraftShapeToOwnerBounds(
    draft.shape,
    draft.ownerBounds,
    draft.frame,
  );
  const shape: components["schemas"]["SceneRegionShape"] =
    clampedShape.kind === "cylinder"
      ? {
          axis: clampedShape.axis,
          center: clampedShape.center,
          height: clampedShape.height,
          kind: "cylinder",
          radius: clampedShape.radius,
        }
      : clampedShape.kind === "sphere"
        ? {
            center: clampedShape.center,
            kind: "sphere",
            radius: clampedShape.radius,
          }
        : {
            center: clampedShape.center,
            kind: "box",
            size: clampedShape.size,
          };
  const meshPolicy: components["schemas"]["SceneRegionMeshPolicy"] | null = draft.meshPolicy.enabled
    ? {
        maximum_element_size: draft.meshPolicy.maximumElementSize,
        minimum_element_size: draft.meshPolicy.minimumElementSize,
        order: Math.max(1, Math.round(draft.meshPolicy.order)),
        transition_distance: draft.meshPolicy.transitionDistance,
      }
    : null;
  const materialOverrides: components["schemas"]["SceneRegionMaterialOverride"][] = draft.materialOverrides.map((override) => {
    const value: components["schemas"]["SceneMaterialParameterField"] = {
      kind: "constant",
      value: override.value,
    };
    if (override.unit.trim().length > 0) {
      value.unit = override.unit.trim();
    }
    return {
      conflict_policy: override.conflictPolicy,
      parameter: override.parameter,
      priority: Math.round(override.priority),
      value,
    };
  });

  return {
    enabled: draft.enabled,
    frame: draft.frame,
    material_overrides: materialOverrides,
    mesh_policy: meshPolicy,
    name: draft.name.trim(),
    priority: draft.priority,
    realization_policy: draft.realizationPolicy,
    shape,
  };
}
