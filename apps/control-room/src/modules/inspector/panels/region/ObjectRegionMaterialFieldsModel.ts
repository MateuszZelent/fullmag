import type {
  MaterialParameterFieldListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { components } from "@/kernel/api/generated/openapi-v2-types";

export type SceneMaterialParameterAssignment =
  components["schemas"]["SceneMaterialParameterAssignment"];
type SceneMaterialParameterField =
  components["schemas"]["SceneMaterialParameterField"];
export type SceneMaterialParameterName =
  components["schemas"]["SceneMaterialParameterName"];
export type SceneRegionConflictPolicy =
  components["schemas"]["SceneRegionConflictPolicy"];
export type SceneRegionFrame = components["schemas"]["SceneRegionFrame"];
export type MaterialFieldSerializationLane = "fdm" | "fem" | "unknown";

export interface MaterialFieldSerializationOptions {
  meshPolicyLane?: MaterialFieldSerializationLane;
}

export type MaterialFieldKind = "constant" | "linear" | "radial";

export interface MaterialFieldDraft {
  assignmentId: string;
  base: number;
  center: [number, number, number];
  conflictPolicy: SceneRegionConflictPolicy;
  frame: SceneRegionFrame;
  gradient: [number, number, number];
  inside: number;
  kind: MaterialFieldKind;
  outside: number;
  parameter: SceneMaterialParameterName;
  priority: number;
  radius: number;
  scalar: number;
  unit: string;
  originalAssignment?: SceneMaterialParameterAssignment;
}

export interface MaterialFieldDraftState {
  fields: MaterialFieldDraft[];
  key: string;
}

export interface MaterialFieldRealizationRow {
  label: string;
  value: string;
}

export const MATERIAL_FIELD_PARAMETERS: SceneMaterialParameterName[] = [
  "ms",
  "aex",
  "alpha",
  "ku1",
  "ku2",
  "dind",
  "dbulk",
];

function vector3FromValue(
  value: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? [value[0], value[1], value[2]]
    : fallback;
}

export function unitForMaterialParameter(
  parameter: SceneMaterialParameterName,
): string {
  if (parameter === "aex") return "J/m";
  if (parameter === "alpha") return "";
  if (parameter === "ku1" || parameter === "ku2") return "J/m^3";
  if (parameter === "dind" || parameter === "dbulk") return "J/m^2";
  if (parameter === "anisotropy_axis") return "";
  return "A/m";
}

export function defaultMaterialFieldDraft(model: {
  objectId: string;
  priority: number | null;
  regionId: string;
}): MaterialFieldDraft {
  return {
    assignmentId: `${model.objectId}:${model.regionId}:field:${Date.now()}`,
    base: 800e3,
    center: [0, 0, 0],
    conflictPolicy: "higher_priority_wins",
    frame: "object",
    gradient: [0, 0, 0],
    inside: 800e3,
    kind: "linear",
    outside: 800e3,
    parameter: "ms",
    priority: model.priority ?? 0,
    radius: 10e-9,
    scalar: 800e3,
    unit: "A/m",
  };
}

export function isEditableMaterialField(
  field: SceneMaterialParameterAssignment,
): boolean {
  if (!MATERIAL_FIELD_PARAMETERS.includes(field.parameter)) return false;
  if (field.value.kind === "constant") {
    return typeof field.value.value === "number";
  }
  if (field.value.kind === "linear") {
    return (
      field.value.gradient.length === 3 &&
      field.value.gradient.every(Number.isFinite) &&
      (field.value.frame === undefined ||
        field.value.frame === "object" ||
        field.value.frame === "world")
    );
  }
  if (field.value.kind === "radial") {
    return (
      field.value.center.length === 3 &&
      field.value.center.every(Number.isFinite) &&
      (field.value.frame === undefined ||
        field.value.frame === "object" ||
        field.value.frame === "world")
    );
  }
  return false;
}

export function materialFieldDraftFromAssignment(
  field: SceneMaterialParameterAssignment,
): MaterialFieldDraft | null {
  if (!isEditableMaterialField(field)) return null;
  const value = field.value;
  const unit = value.unit ?? unitForMaterialParameter(field.parameter);
  if (value.kind === "constant") {
    const scalar = typeof value.value === "number" ? value.value : 0;
    return {
      assignmentId: field.assignment_id,
      base: scalar,
      center: [0, 0, 0],
      conflictPolicy: field.conflict_policy ?? "higher_priority_wins",
      frame: "object",
      gradient: [0, 0, 0],
      inside: scalar,
      kind: "constant",
      outside: scalar,
      parameter: field.parameter,
      priority: field.priority ?? 0,
      radius: 10e-9,
      scalar,
      unit,
      originalAssignment: field,
    };
  }
  if (value.kind === "linear") {
    return {
      assignmentId: field.assignment_id,
      base: value.base,
      center: [0, 0, 0],
      conflictPolicy: field.conflict_policy ?? "higher_priority_wins",
      frame: value.frame ?? "object",
      gradient: vector3FromValue(value.gradient, [0, 0, 0]),
      inside: value.base,
      kind: "linear",
      outside: value.base,
      parameter: field.parameter,
      priority: field.priority ?? 0,
      radius: 10e-9,
      scalar: value.base,
      unit,
      originalAssignment: field,
    };
  }
  if (value.kind === "radial") {
    return {
      assignmentId: field.assignment_id,
      base: value.inside,
      center: vector3FromValue(value.center, [0, 0, 0]),
      conflictPolicy: field.conflict_policy ?? "higher_priority_wins",
      frame: value.frame ?? "object",
      gradient: [0, 0, 0],
      inside: value.inside,
      kind: "radial",
      outside: value.outside,
      parameter: field.parameter,
      priority: field.priority ?? 0,
      radius: value.radius,
      scalar: value.inside,
      unit,
      originalAssignment: field,
    };
  }
  return null;
}

export function materialFieldFromDraft(
  draft: MaterialFieldDraft,
  model: { objectId: string; regionId: string },
  options: MaterialFieldSerializationOptions = {},
): SceneMaterialParameterAssignment {
  const meshPolicyLane = options.meshPolicyLane ?? "fem";
  const original = draft.originalAssignment;
  const originalDraft = original ? materialFieldDraftFromAssignment(original) : null;
  if (
    original &&
    originalDraft &&
    sameMaterialFieldDraftProjection(draft, originalDraft)
  ) {
    return applyMaterialFieldLaneFence(original, meshPolicyLane);
  }

  if (
    original &&
    originalDraft &&
    original.value.kind === draft.kind &&
    isEditableMaterialField(original)
  ) {
    return updateOriginalMaterialField(original, originalDraft, draft, meshPolicyLane);
  }

  let value: SceneMaterialParameterField;
  if (draft.kind === "constant") {
    value = {
      kind: "constant",
      unit: draft.unit || null,
      value: draft.scalar,
    };
  } else if (draft.kind === "linear") {
    value = {
      base: draft.base,
      frame: draft.frame,
      gradient: draft.gradient,
      kind: "linear",
      unit: draft.unit || null,
    };
  } else {
    value = {
      center: draft.center,
      frame: draft.frame,
      inside: draft.inside,
      kind: "radial",
      outside: draft.outside,
      radius: draft.radius,
      unit: draft.unit || null,
    };
  }

  const conflictPolicy =
    meshPolicyLane !== "fem" && draft.conflictPolicy === "min_mesh_size_wins"
      ? undefined
      : draft.conflictPolicy;

  return {
    assignment_id: draft.assignmentId,
    owner_object: model.objectId,
    parameter: draft.parameter,
    priority: Math.trunc(draft.priority),
    region_id: model.regionId,
    value,
    ...(conflictPolicy ? { conflict_policy: conflictPolicy } : {}),
  };
}

function sameMaterialFieldDraftProjection(
  left: MaterialFieldDraft,
  right: MaterialFieldDraft,
): boolean {
  const leftProjection = { ...left };
  const rightProjection = { ...right };
  delete leftProjection.originalAssignment;
  delete rightProjection.originalAssignment;
  return JSON.stringify(leftProjection) === JSON.stringify(rightProjection);
}

function applyMaterialFieldLaneFence(
  assignment: SceneMaterialParameterAssignment,
  meshPolicyLane: MaterialFieldSerializationLane,
): SceneMaterialParameterAssignment {
  if (
    meshPolicyLane !== "fem" &&
    assignment.conflict_policy === "min_mesh_size_wins"
  ) {
    const retained = { ...assignment };
    delete retained.conflict_policy;
    return retained;
  }
  return assignment;
}

function updateOriginalMaterialField(
  original: SceneMaterialParameterAssignment,
  baseline: MaterialFieldDraft,
  draft: MaterialFieldDraft,
  meshPolicyLane: MaterialFieldSerializationLane,
): SceneMaterialParameterAssignment {
  const result: SceneMaterialParameterAssignment = { ...original };
  if (draft.parameter !== baseline.parameter) result.parameter = draft.parameter;
  if (draft.priority !== baseline.priority) result.priority = Math.trunc(draft.priority);
  if (draft.conflictPolicy !== baseline.conflictPolicy) {
    if (
      meshPolicyLane === "fem" ||
      draft.conflictPolicy !== "min_mesh_size_wins"
    ) {
      result.conflict_policy = draft.conflictPolicy;
    } else {
      delete result.conflict_policy;
    }
  }

  const originalValue = original.value;
  if (originalValue.kind === "constant" && draft.kind === "constant") {
    const value: Extract<SceneMaterialParameterField, { kind: "constant" }> = {
      ...originalValue,
    };
    if (draft.scalar !== baseline.scalar) value.value = draft.scalar;
    if (draft.unit !== baseline.unit) value.unit = draft.unit || null;
    result.value = value;
  } else if (originalValue.kind === "linear" && draft.kind === "linear") {
    const value: Extract<SceneMaterialParameterField, { kind: "linear" }> = {
      ...originalValue,
    };
    if (draft.base !== baseline.base) value.base = draft.base;
    if (JSON.stringify(draft.gradient) !== JSON.stringify(baseline.gradient)) {
      value.gradient = draft.gradient;
    }
    if (draft.frame !== baseline.frame) value.frame = draft.frame;
    if (draft.unit !== baseline.unit) value.unit = draft.unit || null;
    result.value = value;
  } else if (originalValue.kind === "radial" && draft.kind === "radial") {
    const value: Extract<SceneMaterialParameterField, { kind: "radial" }> = {
      ...originalValue,
    };
    if (JSON.stringify(draft.center) !== JSON.stringify(baseline.center)) {
      value.center = draft.center;
    }
    if (draft.inside !== baseline.inside) value.inside = draft.inside;
    if (draft.outside !== baseline.outside) value.outside = draft.outside;
    if (draft.radius !== baseline.radius) value.radius = draft.radius;
    if (draft.frame !== baseline.frame) value.frame = draft.frame;
    if (draft.unit !== baseline.unit) value.unit = draft.unit || null;
    result.value = value;
  }

  return applyMaterialFieldLaneFence(result, meshPolicyLane);
}

export function materialFieldDraftKey(
  fields: readonly SceneMaterialParameterAssignment[],
): string {
  return JSON.stringify(fields);
}

function formatRealizedValue(value: number, unit: string | null | undefined): string {
  return `${value} ${unit ?? ""}`.trim();
}

export function materialFieldRealizationRows(
  assignmentId: string,
  materialFields: MaterialParameterFieldListResource | null | undefined,
): MaterialFieldRealizationRow[] {
  const field = materialFields?.fields.find(
    (entry) => entry.assignment_id === assignmentId,
  );
  if (!field) return [];

  const rows: MaterialFieldRealizationRow[] = [];
  if (field.realization_status) {
    rows.push({ label: "Realization", value: field.realization_status });
  }
  if (typeof field.sample_count === "number") {
    rows.push({ label: "Samples", value: String(field.sample_count) });
  }
  if (typeof field.min === "number") {
    rows.push({
      label: "Min",
      value: formatRealizedValue(field.min, field.unit),
    });
  }
  if (typeof field.max === "number") {
    rows.push({
      label: "Max",
      value: formatRealizedValue(field.max, field.unit),
    });
  }
  if (typeof field.mean === "number") {
    rows.push({
      label: "Mean",
      value: formatRealizedValue(field.mean, field.unit),
    });
  }
  if (field.warnings?.length) {
    rows.push({ label: "Warnings", value: field.warnings.join("; ") });
  }
  return rows;
}

export function sceneObjectMaterialFields(
  sceneData: SceneResource | null | undefined,
  objectId: string,
): SceneMaterialParameterAssignment[] {
  const object = sceneData?.objects?.find((entry) => entry.id === objectId);
  return object?.material_parameter_fields ?? [];
}
