import type {
  JsonObject,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { PrimitiveDraft } from "@/kernel/authoring/geometryLifecycleCommands";
import type {
  GeometryObjectDraft,
  QuantityDraftField,
} from "@/kernel/authoring/object-edit/objectEditTypes";
export type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import {
  geometryDraftQuantityEquals,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import {
  canonicalDraftInSelectedUnits,
  getRawQuantityField,
  parseDraftQuantityField,
  setRawQuantityField,
} from "@/kernel/authoring/object-edit/quantityDraftFields";
export {
  geometryDraftGeometryEquals,
  geometryDraftTranslationEquals,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { parseQuantityInput } from "@/kernel/authoring/object-edit/quantityInput";

export interface GeometryObjectPanelModel {
  dimensions: string;
  material: string;
  meshStatus: string;
  mode: "committed" | "draft-new" | "missing";
  name: string;
  notes: string;
  objectId: string;
  region: string;
  revision: number | null;
  shape: string;
  source: string;
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

export function isPrimitiveDraftRevisionConflict(error: unknown): boolean {
  return error instanceof ControlRoomApiError &&
    error.status === 409 &&
    (error.code === "revision_conflict" || error.code === "scene_revision_conflict");
}

function rebaseVector3(
  draftVec: readonly [string, string, string] | readonly string[],
  targetVec: readonly [string, string, string] | readonly string[],
  baseVec: readonly [string, string, string] | readonly string[],
): [string, string, string] {
  const result: [string, string, string] = [
    targetVec[0] ?? "0",
    targetVec[1] ?? "0",
    targetVec[2] ?? "0",
  ];
  for (let i = 0; i < 3; i++) {
    const d = draftVec[i] ?? "";
    const b = baseVec[i] ?? "";
    const t = targetVec[i] ?? "";
    const draftChanged = d !== b;
    const targetChanged = t !== b;
    if (draftChanged && !targetChanged) {
      result[i] = d;
    } else if (!draftChanged && targetChanged) {
      result[i] = t;
    } else if (draftChanged && targetChanged) {
      result[i] = d;
    } else {
      result[i] = t;
    }
  }
  return result;
}

function quantityFieldUnchangedForRebase(
  draft: GeometryObjectDraft,
  baseline: GeometryObjectDraft,
  field: QuantityDraftField,
): boolean {
  if (geometryDraftQuantityEquals(draft, baseline, field)) return true;
  const draftValue = parseDraftQuantityField(draft, field);
  const baselineValue = parseDraftQuantityField(baseline, field);
  return draftValue.parseStatus !== "valid" &&
    baselineValue.parseStatus !== "valid" &&
    getRawQuantityField(draft, field) === getRawQuantityField(baseline, field) &&
    draftValue.unit === baselineValue.unit &&
    draftValue.lastValidSI === baselineValue.lastValidSI;
}

export function rebaseGeometryObjectDraft(
  draft: GeometryObjectDraft,
  target: GeometryObjectDraft | number | null,
  baseline?: GeometryObjectDraft | null,
): GeometryObjectDraft {
  if (typeof target === "number" || target === null) {
    return { ...draft, baseRevision: target };
  }
  if (!baseline) {
    return { ...draft, baseRevision: target.baseRevision };
  }
  let merged: GeometryObjectDraft = canonicalDraftInSelectedUnits(target, draft);
  const vectorFields = new Set([
    "rotation",
    "scale",
    "bounds_min",
    "bounds_max",
  ]);
  const quantityRawFields = new Set<keyof GeometryObjectDraft>([
    "size",
    "translation",
    "radius",
    "height",
    "length",
    "width",
    "archHeight",
    "z0",
    "quantityFields",
  ]);
  const quantityKeys: readonly QuantityDraftField[] = [
    "size.0",
    "size.1",
    "size.2",
    "translation.0",
    "translation.1",
    "translation.2",
    "radius",
    "height",
    "length",
    "width",
    "archHeight",
    "z0",
  ];
  for (const field of quantityKeys) {
    if (quantityFieldUnchangedForRebase(draft, baseline, field)) continue;
    merged = setRawQuantityField(merged, field, getRawQuantityField(draft, field));
    const nextQuantityFields = { ...merged.quantityFields };
    const localMetadata = draft.quantityFields?.[field];
    if (localMetadata) nextQuantityFields[field] = localMetadata;
    else delete nextQuantityFields[field];
    const nextMerged: GeometryObjectDraft = {
      ...merged,
      quantityFields: nextQuantityFields,
    };
    if (Object.keys(nextQuantityFields).length === 0) {
      delete nextMerged.quantityFields;
    }
    merged = nextMerged;
  }
  const fields = Object.keys(draft) as (keyof GeometryObjectDraft)[];
  for (const field of fields) {
    if (field === "baseRevision" || quantityRawFields.has(field)) continue;
    const draftVal = draft[field];
    const baseVal = baseline[field];
    const targetVal = target[field];
    if (
      vectorFields.has(field) &&
      Array.isArray(draftVal) &&
      Array.isArray(targetVal) &&
      Array.isArray(baseVal)
    ) {
      const mergedVec = rebaseVector3(
        draftVal as readonly string[],
        targetVal as readonly string[],
        baseVal as readonly string[],
      );
      Object.assign(merged, { [field]: mergedVec });
      continue;
    }
    const isDirty = Array.isArray(draftVal)
      ? JSON.stringify(draftVal) !== JSON.stringify(baseVal)
      : draftVal !== baseVal;
    Object.assign(merged, { [field]: isDirty ? draftVal : targetVal });
  }
  return merged;
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

function asNumberArray(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? value
    : null;
}

function lengthScale(values: readonly number[]): { scale: number; unit: string } {
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 0);
  if (maxAbs >= 1e-3) return { scale: 1e3, unit: "mm" };
  if (maxAbs >= 1e-6) return { scale: 1e6, unit: "um" };
  return { scale: 1e9, unit: "nm" };
}

function formatDimension(value: number, scale: number): string {
  const scaled = value * scale;
  if (!Number.isFinite(scaled)) return String(scaled);
  if (scaled === 0) return "0.0";

  const rounded = Number(scaled.toPrecision(6));
  const text = String(rounded);
  return Number.isInteger(rounded) && !/[eE]/.test(text)
    ? `${text}.0`
    : text;
}

function formatDimensions(geometry: JsonRecord | null): string {
  const params = asRecord(geometry?.geometry_params);
  const size =
    archWaveguideSize(params) ??
    asNumberArray(params?.size) ??
    asNumberArray(params?.dimensions) ??
    boundsSize(geometry);
  if (!size?.length) return "unresolved";
  const { scale, unit } = lengthScale(size);
  return `${size.map((value) => formatDimension(value, scale)).join(" x ")} ${unit}`;
}

function archWaveguideSize(params: JsonRecord | null): number[] | null {
  const length = asNumber(params?.length);
  const width = asNumber(params?.width);
  const height = asNumber(params?.height);
  const archHeight = asNumber(params?.arch_height);
  if (length === null || width === null || height === null || archHeight === null) {
    return null;
  }
  return [length, width, height + archHeight];
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
    archHeight: "",
    baseRevision: revision,
    geometryKind,
    height: geometryKind === "Cylinder" ? "1e-8" : "",
    length: "",
    material: "unassigned",
    mode: "draft-new",
    name: selection.label ?? `New ${primitiveKind}`,
    notes: "",
    objectId: "draft",
    radius: geometryKind === "Box" ? "" : "5e-8",
    region: "unassigned",
    rotation: ["0", "0", "0"],
    scale: ["1", "1", "1"],
    size: ["1e-7", "1e-7", "1e-8"],
    translation: ["0", "0", "0"],
    width: "",
    z0: "",
  };
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
      notes: "",
      objectId: objectId ?? "none",
    };
  }

  return resolveCommittedGeometryObjectDraft(scene, objectId) ?? {
    ...defaultDraftForPrimitive(selection, revision),
    mode: "missing",
    notes: "",
    objectId,
  };
}

type DraftQuantityParseResult =
  | { error: null; previewValue: number; value: number }
  | { error: string; previewValue: number | null; value: null };

const POSITIVE_QUANTITY_FIELDS = new Set<QuantityDraftField>([
  "size.0",
  "size.1",
  "size.2",
  "radius",
  "height",
  "length",
  "width",
  "archHeight",
]);

function parseQuantityField(
  draft: GeometryObjectDraft,
  field: QuantityDraftField,
  label: string,
): DraftQuantityParseResult {
  const parsed = parseDraftQuantityField(draft, field);
  if (parsed.parseStatus === "valid" && parsed.parsedSI !== null) {
    return {
      error: null,
      previewValue: parsed.parsedSI,
      value: parsed.parsedSI,
    };
  }

  let error: string;
  if (parsed.parseStatus === "empty") {
    error = `${label} is required.`;
  } else if (parsed.parseStatus === "incomplete") {
    error = `${label} is incomplete.`;
  } else {
    const rawParsed = parseQuantityInput(
      getRawQuantityField(draft, field),
      "length",
      draft.quantityFields?.[field]?.unit ?? "m",
    );
    error = POSITIVE_QUANTITY_FIELDS.has(field) &&
      rawParsed.parseStatus === "valid" &&
      rawParsed.parsedSI !== null &&
      rawParsed.parsedSI <= 0
      ? `${label} must be greater than 0.`
      : `${label} must be a finite SI value.`;
  }
  return {
    error,
    previewValue: parsed.lastValidSI,
    value: null,
  };
}

function parseVector(
  draft: GeometryObjectDraft,
  field: "size" | "translation",
  label: string,
): { error: string | null; value: [number, number, number] | null } {
  const fields: readonly QuantityDraftField[] = field === "size"
    ? ["size.0", "size.1", "size.2"]
    : ["translation.0", "translation.1", "translation.2"];
  const parsed = fields.map((quantityField, index) =>
    parseQuantityField(draft, quantityField, `${label} ${index + 1}`),
  );
  const failed = parsed.find((component) => component.error !== null);
  if (failed) return { error: failed.error, value: null };
  const values = parsed.flatMap((component) =>
    component.value === null ? [] : [component.value],
  );
  return {
    error: null,
    value: values as [number, number, number],
  };
}

function primitiveDraftKind(kind: string): PrimitiveDraft["kind"] {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "cylinder") return "Cylinder";
  if (normalized === "sphere") return "Sphere";
  return "Box";
}

export function resolvePrimitiveDraft(draft: GeometryObjectDraft): PrimitiveDraft {
  const kind = primitiveDraftKind(draft.geometryKind);
  const errors: Record<string, string> = {};
  const translationFields: readonly QuantityDraftField[] = [
    "translation.0",
    "translation.1",
    "translation.2",
  ];
  const translationParsed = translationFields.map((field, index) =>
    parseQuantityField(draft, field, `Translation ${"XYZ"[index]}`),
  );
  translationParsed.forEach((parsed, index) => {
    if (parsed.error) errors[translationFields[index]] = parsed.error;
  });
  let dimensionFields: readonly QuantityDraftField[];
  let dimensionLabels: readonly string[];
  if (kind === "Box") {
    dimensionFields = ["size.0", "size.1", "size.2"];
    dimensionLabels = ["Box size X", "Box size Y", "Box size Z"];
  } else if (kind === "Cylinder") {
    dimensionFields = ["radius", "height", "radius"];
    dimensionLabels = ["Cylinder radius", "Cylinder height", "Cylinder radius"];
  } else {
    dimensionFields = ["radius", "radius", "radius"];
    dimensionLabels = ["Sphere radius", "Sphere radius", "Sphere radius"];
  }
  const parsedDimensions = dimensionFields.map((field, index) =>
    parseQuantityField(draft, field, dimensionLabels[index]),
  );
  parsedDimensions.forEach((parsed, index) => {
    if (parsed.error) errors[dimensionFields[index]] = parsed.error;
  });
  const dimensionValues = parsedDimensions.map((parsed) => parsed.previewValue);
  const dimensions = dimensionValues.every((value): value is number => value !== null)
    ? kind === "Box"
      ? dimensionValues
      : dimensionValues.map((value, index) =>
          index === 1 && kind === "Cylinder" ? value : value * 2,
        )
    : null;
  const translationValues = translationParsed.map((parsed) => parsed.previewValue);
  const translation = translationValues.every((value): value is number => value !== null)
    ? translationValues
    : null;

  return {
    dimensions: dimensions as [number, number, number] | null,
    errors,
    kind,
    translation: translation as [number, number, number] | null,
  };
}

function normalizedGeometryKind(
  kind: string,
): "ArchWaveguide" | "Box" | "Cylinder" | "Sphere" | null {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "archwaveguide" || normalized === "arch_waveguide") {
    return "ArchWaveguide";
  }
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
    const size = parseVector(draft, "size", "Box size");
    if (size.error || size.value === null) {
      return { error: size.error ?? "Box size is invalid.", geometry: null };
    }
    return {
      error: null,
      geometry: {
        geometry_kind: "Box",
        geometry_params: { size: size.value },
      },
    };
  }

  if (geometryKind === "ArchWaveguide") {
    const length = parseQuantityField(draft, "length", "Arch waveguide length");
    if (length.error) return { error: length.error, geometry: null };
    const width = parseQuantityField(draft, "width", "Arch waveguide width");
    if (width.error) return { error: width.error, geometry: null };
    const height = parseQuantityField(draft, "height", "Arch waveguide height");
    if (height.error) return { error: height.error, geometry: null };
    const archHeight = parseQuantityField(
      draft,
      "archHeight",
      "Arch waveguide arch height",
    );
    if (archHeight.error) return { error: archHeight.error, geometry: null };
    const z0 = parseQuantityField(draft, "z0", "Arch waveguide z0");
    if (z0.error) return { error: z0.error, geometry: null };
    return {
      error: null,
      geometry: {
        geometry_kind: "ArchWaveguide",
        geometry_params: {
          arch_height: archHeight.value,
          height: height.value,
          length: length.value,
          width: width.value,
          z0: z0.value,
        },
      },
    };
  }

  if (geometryKind === "Cylinder") {
    const radius = parseQuantityField(draft, "radius", "Cylinder radius");
    if (radius.error) return { error: radius.error, geometry: null };
    const height = parseQuantityField(draft, "height", "Cylinder height");
    if (height.error) return { error: height.error, geometry: null };
    return {
      error: null,
      geometry: {
        geometry_kind: "Cylinder",
        geometry_params: { height: height.value, radius: radius.value },
      },
    };
  }

  const radius = parseQuantityField(draft, "radius", "Sphere radius");
  if (radius.error) return { error: radius.error, geometry: null };
  return {
    error: null,
    geometry: {
      geometry_kind: "Sphere",
      geometry_params: { radius: radius.value },
    },
  };
}

function persistedTransformVector(
  transform: JsonRecord | null,
  field: string,
  length: number,
  fallback: readonly number[],
): { error: string | null; value: number[] } {
  const value = transform?.[field];
  if (value === undefined || value === null) {
    return { error: null, value: [...fallback] };
  }
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    return {
      error: "The existing transform " + field + " must contain " + length + " finite values.",
      value: [],
    };
  }
  return { error: null, value: [...value] as number[] };
}

export function buildTransformDraftPatch(
  draft: GeometryObjectDraft,
  existingTransform?: unknown,
): GeometryDraftTransformResult {
  const translation = parseVector(draft, "translation", "Translation");
  if (translation.error || translation.value === null) {
    return {
      error: translation.error ?? "Translation is invalid.",
      transform: null,
    };
  }
  const transform =
    existingTransform === undefined || existingTransform === null
      ? null
      : asRecord(existingTransform);
  if (existingTransform !== undefined && existingTransform !== null && !transform) {
    return { error: "The existing object transform is not a valid record.", transform: null };
  }
  const rotation = persistedTransformVector(transform, "rotation_quat", 4, [0, 0, 0, 1]);
  const scale = persistedTransformVector(transform, "scale", 3, [1, 1, 1]);
  const pivot = persistedTransformVector(transform, "pivot", 3, [0, 0, 0]);
  const invalid = [rotation, scale, pivot].find((component) => component.error);
  if (invalid?.error) return { error: invalid.error, transform: null };

  return {
    error: null,
    transform: {
      pivot: pivot.value,
      rotation_quat: rotation.value,
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
      notes: "",
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
      notes: "",
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
    notes: asString(object.notes) ?? "",
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

export function mergeGeometryDescriptor(
  existing: JsonObject,
  edited: JsonObject,
): JsonObject {
  const existingParams = existing.geometry_params;
  const editedParams = edited.geometry_params;
  const mergedParams =
    existingParams && typeof existingParams === "object" && !Array.isArray(existingParams) &&
    editedParams && typeof editedParams === "object" && !Array.isArray(editedParams)
      ? { ...existingParams, ...editedParams }
      : editedParams;
  return {
    ...existing,
    ...edited,
    ...(mergedParams ? { geometry_params: mergedParams as JsonObject } : {}),
  };
}
