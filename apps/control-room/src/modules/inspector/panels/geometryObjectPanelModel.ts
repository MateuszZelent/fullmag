import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

export interface GeometryObjectPanelModel {
  dimensions: string;
  material: string;
  meshStatus: string;
  mode: "committed" | "draft-new" | "missing";
  name: string;
  objectId: string;
  region: string;
  revision: number | null;
  shape: string;
  source: string;
}

export interface GeometryObjectDraft {
  baseRevision: number | null;
  geometryKind: string;
  height: string;
  material: string;
  mode: "committed" | "draft-new" | "missing";
  name: string;
  objectId: string;
  radius: string;
  region: string;
  rotation: [string, string, string];
  scale: [string, string, string];
  size: [string, string, string];
  translation: [string, string, string];
}

export interface GeometryDraftGeometryResult {
  error: string | null;
  geometry: JsonObject | null;
}

export interface GeometryDraftTransformResult {
  error: string | null;
  transform: JsonObject | null;
}

type JsonRecord = Record<string, unknown>;

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

function asNumberArray(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? value
    : null;
}

function formatNumberInput(value: unknown, fallback: number): string {
  const numberValue = asNumber(value);
  return String(numberValue ?? fallback);
}

function formatVectorInput(
  value: unknown,
  fallback: readonly [number, number, number],
): [string, string, string] {
  const values = asNumberArray(value);
  return [
    String(values?.[0] ?? fallback[0]),
    String(values?.[1] ?? fallback[1]),
    String(values?.[2] ?? fallback[2]),
  ];
}

function lengthScale(values: readonly number[]): { scale: number; unit: string } {
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 0);
  if (maxAbs >= 1e-3) return { scale: 1e3, unit: "mm" };
  if (maxAbs >= 1e-6) return { scale: 1e6, unit: "um" };
  return { scale: 1e9, unit: "nm" };
}

function formatDimensions(geometry: JsonRecord | null): string {
  const params = asRecord(geometry?.geometry_params);
  const size =
    asNumberArray(params?.size) ??
    asNumberArray(params?.dimensions) ??
    boundsSize(geometry);
  if (!size?.length) return "unresolved";
  const { scale, unit } = lengthScale(size);
  return `${size.map((value) => (value * scale).toFixed(1)).join(" x ")} ${unit}`;
}

function boundsSize(geometry: JsonRecord | null): number[] | null {
  const min = asNumberArray(geometry?.bounds_min);
  const max = asNumberArray(geometry?.bounds_max);
  if (!min || !max || min.length < 3 || max.length < 3) return null;
  return [
    Math.max((max[0] ?? 0) - (min[0] ?? 0), 0),
    Math.max((max[1] ?? 0) - (min[1] ?? 0), 0),
    Math.max((max[2] ?? 0) - (min[2] ?? 0), 0),
  ];
}

function meshStatus(tags: unknown): string {
  const values = Array.isArray(tags) ? tags : [];
  if (values.includes("validation:blocked")) return "validation-blocked";
  if (values.includes("mesh:building")) return "mesh-building";
  if (values.includes("mesh:failed")) return "mesh-failed";
  if (values.includes("mesh:dirty")) return "mesh-stale";
  if (values.includes("mesh:ready")) return "mesh-ready";
  return "primitive-only";
}

function primitiveKindFromSelection(selection: Selection): string {
  const suffix = selection.nodeId?.split(":").at(-1);
  return suffix && suffix !== "draft" ? suffix : "primitive";
}

function sceneObjectForSelection(
  selection: Selection,
  scene: SceneResource | null,
): { object: JsonRecord | null; objectId: string | null; revision: number | null } {
  const objectId = selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
  const sceneRecord = asRecord(scene);
  const sceneObjects = sceneRecord?.objects;
  const object = Array.isArray(sceneObjects)
    ? sceneObjects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;

  return {
    object,
    objectId,
    revision: asNumber(sceneRecord?.revision),
  };
}

function defaultDraftForPrimitive(
  selection: Selection,
  revision: number | null,
): GeometryObjectDraft {
  const primitiveKind = primitiveKindFromSelection(selection);
  const geometryKind =
    primitiveKind === "cylinder"
      ? "Cylinder"
      : primitiveKind === "sphere"
        ? "Sphere"
        : "Box";

  return {
    baseRevision: revision,
    geometryKind,
    height: geometryKind === "Cylinder" ? "1e-8" : "",
    material: "unassigned",
    mode: "draft-new",
    name: selection.label ?? `New ${primitiveKind}`,
    objectId: "draft",
    radius: geometryKind === "Box" ? "" : "5e-8",
    region: "unassigned",
    rotation: ["0", "0", "0"],
    scale: ["1", "1", "1"],
    size: ["1e-7", "1e-7", "1e-8"],
    translation: ["0", "0", "0"],
  };
}

function stringOrFallback(value: unknown, fallback: string): string {
  return asString(value) ?? fallback;
}

export function resolveGeometryObjectDraft(
  selection: Selection,
  scene: SceneResource | null,
): GeometryObjectDraft {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);

  if (selection.kind === "builder.primitive") {
    return defaultDraftForPrimitive(selection, revision);
  }

  if (!object || !objectId) {
    return {
      ...defaultDraftForPrimitive(selection, revision),
      mode: "missing",
      objectId: objectId ?? "none",
    };
  }

  const geometry = asRecord(object.geometry);
  const params = asRecord(geometry?.geometry_params);
  const transform = asRecord(object.transform);
  const geometryKind =
    asString(geometry?.geometry_kind) ??
    asString(geometry?.kind) ??
    "Box";

  return {
    baseRevision: revision,
    geometryKind,
    height: formatNumberInput(params?.height, 1e-8),
    material: stringOrFallback(object.material_ref, "unassigned"),
    mode: "committed",
    name: stringOrFallback(object.name, objectId),
    objectId,
    radius: formatNumberInput(params?.radius, 5e-8),
    region: stringOrFallback(object.region_name, "unassigned"),
    rotation: formatVectorInput(transform?.rotation, [0, 0, 0]),
    scale: formatVectorInput(transform?.scale, [1, 1, 1]),
    size: formatVectorInput(params?.size ?? params?.dimensions, [1e-7, 1e-7, 1e-8]),
    translation: formatVectorInput(transform?.translation, [0, 0, 0]),
  };
}

function parseFiniteNumber(value: string, label: string): { error: string | null; value: number } {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `${label} must be a finite SI value.`, value: 0 };
  }
  return { error: null, value: parsed };
}

function parsePositiveNumber(value: string, label: string): { error: string | null; value: number } {
  const parsed = parseFiniteNumber(value, label);
  if (parsed.error) return parsed;
  if (parsed.value <= 0) {
    return { error: `${label} must be greater than 0.`, value: parsed.value };
  }
  return parsed;
}

function parseVector(
  values: readonly [string, string, string],
  label: string,
  positive: boolean,
): { error: string | null; value: [number, number, number] } {
  const result: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const componentLabel = `${label} ${index + 1}`;
    const parsed = positive
      ? parsePositiveNumber(values[index], componentLabel)
      : parseFiniteNumber(values[index], componentLabel);
    if (parsed.error) {
      return { error: parsed.error, value: [0, 0, 0] };
    }
    result.push(parsed.value);
  }
  return { error: null, value: result as [number, number, number] };
}

function normalizedGeometryKind(kind: string): "Box" | "Cylinder" | "Sphere" | null {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "box") return "Box";
  if (normalized === "cylinder") return "Cylinder";
  if (normalized === "sphere") return "Sphere";
  return null;
}

export function buildGeometryDraftPatch(
  draft: GeometryObjectDraft,
): GeometryDraftGeometryResult {
  const geometryKind = normalizedGeometryKind(draft.geometryKind);
  if (!geometryKind) {
    return {
      error: `Unsupported editable geometry kind: ${draft.geometryKind}.`,
      geometry: null,
    };
  }

  if (geometryKind === "Box") {
    const size = parseVector(draft.size, "Box size", true);
    if (size.error) return { error: size.error, geometry: null };
    return {
      error: null,
      geometry: {
        geometry_kind: "Box",
        geometry_params: { size: size.value },
      },
    };
  }

  if (geometryKind === "Cylinder") {
    const radius = parsePositiveNumber(draft.radius, "Cylinder radius");
    if (radius.error) return { error: radius.error, geometry: null };
    const height = parsePositiveNumber(draft.height, "Cylinder height");
    if (height.error) return { error: height.error, geometry: null };
    return {
      error: null,
      geometry: {
        geometry_kind: "Cylinder",
        geometry_params: { height: height.value, radius: radius.value },
      },
    };
  }

  const radius = parsePositiveNumber(draft.radius, "Sphere radius");
  if (radius.error) return { error: radius.error, geometry: null };
  return {
    error: null,
    geometry: {
      geometry_kind: "Sphere",
      geometry_params: { radius: radius.value },
    },
  };
}

export function buildTransformDraftPatch(
  draft: GeometryObjectDraft,
): GeometryDraftTransformResult {
  const translation = parseVector(draft.translation, "Translation", false);
  if (translation.error) return { error: translation.error, transform: null };
  const rotation = parseVector(draft.rotation, "Rotation", false);
  if (rotation.error) return { error: rotation.error, transform: null };
  const scale = parseVector(draft.scale, "Scale", true);
  if (scale.error) return { error: scale.error, transform: null };

  return {
    error: null,
    transform: {
      rotation: rotation.value,
      scale: scale.value,
      translation: translation.value,
    },
  };
}

export function createDraftObjectId(draft: GeometryObjectDraft, now = Date.now()): string {
  const slug = draft.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || draft.geometryKind.toLowerCase()}-${now.toString(36)}`;
}

function validationMessageFromRecord(record: JsonRecord): string | null {
  return (
    asString(record.message) ??
    asString(record.error) ??
    asString(record.reason) ??
    asString(record.detail) ??
    asString(record.description)
  );
}

function recordTargetsObject(record: JsonRecord, objectId: string): boolean {
  const target =
    asString(record.object_id) ??
    asString(record.objectId) ??
    asString(record.target_id) ??
    asString(record.targetId);
  return !target || target === objectId || target === `object:${objectId}`;
}

export function summarizeGeometryValidationMessages(
  validation: unknown,
  objectId: string,
): string[] {
  const messages: string[] = [];
  const visit = (value: unknown): void => {
    if (messages.length >= 5) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    if (recordTargetsObject(record, objectId)) {
      const message = validationMessageFromRecord(record);
      if (message && !messages.includes(message)) {
        messages.push(message);
      }
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(validation);
  return messages;
}

export function resolveGeometryObjectPanelModel(
  selection: Selection,
  scene: SceneResource | null,
): GeometryObjectPanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);

  if (selection.kind === "builder.primitive") {
    const primitiveKind = primitiveKindFromSelection(selection);
    return {
      dimensions: "draft",
      material: "unassigned",
      meshStatus: "primitive-only",
      mode: "draft-new",
      name: selection.label ?? `New ${primitiveKind}`,
      objectId: "draft",
      region: "unassigned",
      revision,
      shape: primitiveKind,
      source: "Inspector draft",
    };
  }

  const geometry = asRecord(object?.geometry);

  if (!object || !objectId) {
    return {
      dimensions: "unresolved",
      material: "unassigned",
      meshStatus: "primitive-only",
      mode: "missing",
      name: selection.label ?? "No object",
      objectId: objectId ?? "none",
      region: "unassigned",
      revision,
      shape: selection.kind ?? "object",
      source: "SceneDocument",
    };
  }

  return {
    dimensions: formatDimensions(geometry),
    material: asString(object.material_ref) ?? "unassigned",
    meshStatus: meshStatus(object.tags),
    mode: "committed",
    name: asString(object.name) ?? objectId,
    objectId,
    region: asString(object.region_name) ?? "unassigned",
    revision,
    shape:
      asString(geometry?.geometry_kind) ??
      asString(geometry?.kind) ??
      "object",
    source: "SceneDocument",
  };
}
