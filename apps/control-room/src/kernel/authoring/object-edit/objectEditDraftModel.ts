import type { SceneResource } from "@/kernel/api/apiTypes";

import type { GeometryObjectDraft, QuantityDraftField } from "./objectEditTypes";
import { parseDraftQuantityField } from "./quantityDraftFields";

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

function formatScientificInput(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1e-4 || abs >= 1e6) {
    return value.toExponential().replace(/\.0+e/, "e").replace(/(\.\d*?[1-9])0+e/, "$1e");
  }
  return String(value);
}

function formatNumberInput(value: unknown, fallback: number): string {
  return formatScientificInput(asNumber(value) ?? fallback);
}

function formatVectorInput(
  value: unknown,
  fallback: readonly [number, number, number],
): [string, string, string] {
  const values = asNumberArray(value);
  return [
    formatScientificInput(values?.[0] ?? fallback[0]),
    formatScientificInput(values?.[1] ?? fallback[1]),
    formatScientificInput(values?.[2] ?? fallback[2]),
  ];
}

function stringOrFallback(value: unknown, fallback: string): string {
  return asString(value) ?? fallback;
}

/** Canonical draft hydration shared by the Inspector and viewport authoring paths. */
export function resolveCommittedGeometryObjectDraft(
  scene: SceneResource | null,
  objectId: string,
): GeometryObjectDraft | null {
  const sceneRecord = asRecord(scene);
  const objects = sceneRecord?.objects;
  const object = Array.isArray(objects)
    ? objects.map(asRecord).find((candidate) => asString(candidate?.id) === objectId) ?? null
    : null;
  if (!object) return null;

  const geometry = asRecord(object.geometry);
  const params = asRecord(geometry?.geometry_params);
  const transform = asRecord(object.transform);
  return {
    archHeight: formatNumberInput(params?.arch_height, 5e-8),
    baseRevision: asNumber(sceneRecord?.revision),
    geometryKind:
      asString(geometry?.geometry_kind) ?? asString(geometry?.kind) ?? "Box",
    height: formatNumberInput(params?.height, 1e-8),
    length: formatNumberInput(params?.length, 1e-6),
    material: stringOrFallback(object.material_ref, "unassigned"),
    mode: "committed",
    name: stringOrFallback(object.name, objectId),
    notes: asString(object.notes) ?? "",
    objectId,
    radius: formatNumberInput(params?.radius, 5e-8),
    region: stringOrFallback(object.region_name, "unassigned"),
    rotation: formatVectorInput(transform?.rotation, [0, 0, 0]),
    scale: formatVectorInput(transform?.scale, [1, 1, 1]),
    size: formatVectorInput(params?.size ?? params?.dimensions, [1e-7, 1e-7, 1e-8]),
    translation: formatVectorInput(transform?.translation, [0, 0, 0]),
    width: formatNumberInput(params?.width, 1e-6),
    z0: formatNumberInput(params?.z0, 0),
  };
}

export function geometryObjectEditSessionTargetKey(
  sessionScopeKey: string | null,
  draft: Pick<GeometryObjectDraft, "mode" | "objectId">,
): string {
  return JSON.stringify([sessionScopeKey, `${draft.mode}:${draft.objectId}`]);
}

function numericDraftValue(
  draft: GeometryObjectDraft,
  field: QuantityDraftField,
): number | null {
  const parsed = parseDraftQuantityField(draft, field);
  return parsed.parseStatus === "valid" ? parsed.parsedSI : null;
}

function geometryCharacteristicLength(draft: GeometryObjectDraft): number {
  const values = [
    numericDraftValue(draft, "size.0"),
    numericDraftValue(draft, "size.1"),
    numericDraftValue(draft, "size.2"),
    numericDraftValue(draft, "radius"),
    numericDraftValue(draft, "height"),
    numericDraftValue(draft, "length"),
    numericDraftValue(draft, "width"),
    numericDraftValue(draft, "archHeight"),
  ].filter((value): value is number => value !== null);
  return values.reduce((maximum, value) => {
    const magnitude = Math.abs(value);
    return magnitude > maximum ? magnitude : maximum;
  }, 0);
}

function float64Ulp(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude === 0 || magnitude < 2 ** -1022) return Number.MIN_VALUE;
  return 2 ** (Math.floor(Math.log2(magnitude)) - 52);
}

export function geometryDraftLengthValuesEqual(
  left: number,
  right: number,
  characteristicLength = 0,
): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const finiteCharacteristicLength = Number.isFinite(characteristicLength)
    ? Math.abs(characteristicLength)
    : 0;
  const magnitude = Math.max(
    Math.abs(left),
    Math.abs(right),
    finiteCharacteristicLength,
  );
  return Math.abs(left - right) <= 8 * float64Ulp(magnitude);
}

function sameLengthValue(
  left: GeometryObjectDraft,
  leftField: QuantityDraftField,
  right: GeometryObjectDraft,
  rightField: QuantityDraftField,
  characteristicLength: number,
): boolean {
  const a = numericDraftValue(left, leftField);
  const b = numericDraftValue(right, rightField);
  if (a === null || b === null) return false;
  return geometryDraftLengthValuesEqual(a, b, characteristicLength);
}

function sameLengthVector(
  left: GeometryObjectDraft,
  right: GeometryObjectDraft,
  field: "size" | "translation",
  characteristicLength: number,
): boolean {
  const fields: readonly QuantityDraftField[] = field === "size"
    ? ["size.0", "size.1", "size.2"]
    : ["translation.0", "translation.1", "translation.2"];
  return fields.every((axisField) =>
    sameLengthValue(left, axisField, right, axisField, characteristicLength),
  );
}

/** Compares one length field using each draft's selected unit and SI value. */
export function geometryDraftQuantityEquals(
  left: GeometryObjectDraft,
  right: GeometryObjectDraft,
  field: QuantityDraftField,
): boolean {
  const characteristicLength = Math.max(
    geometryCharacteristicLength(left),
    geometryCharacteristicLength(right),
  );
  return sameLengthValue(left, field, right, field, characteristicLength);
}

function normalizedDraftGeometryKind(
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

export function geometryDraftGeometryEquals(
  left: GeometryObjectDraft,
  right: GeometryObjectDraft,
): boolean {
  const leftKind = normalizedDraftGeometryKind(left.geometryKind);
  const rightKind = normalizedDraftGeometryKind(right.geometryKind);
  if (leftKind === null && rightKind === null) {
    return left.geometryKind.trim().toLowerCase() === right.geometryKind.trim().toLowerCase();
  }
  if (leftKind === null || leftKind !== rightKind) return false;
  const characteristicLength = Math.max(
    geometryCharacteristicLength(left),
    geometryCharacteristicLength(right),
  );
  if (leftKind === "Box") {
    return sameLengthVector(left, right, "size", characteristicLength);
  }
  if (leftKind === "Cylinder") {
    return sameLengthValue(left, "radius", right, "radius", characteristicLength) &&
      sameLengthValue(left, "height", right, "height", characteristicLength);
  }
  if (leftKind === "Sphere") {
    return sameLengthValue(left, "radius", right, "radius", characteristicLength);
  }
  return sameLengthValue(left, "length", right, "length", characteristicLength) &&
    sameLengthValue(left, "width", right, "width", characteristicLength) &&
    sameLengthValue(left, "height", right, "height", characteristicLength) &&
    sameLengthValue(left, "archHeight", right, "archHeight", characteristicLength) &&
    sameLengthValue(left, "z0", right, "z0", characteristicLength);
}

export function geometryDraftTranslationEquals(
  left: GeometryObjectDraft,
  right: GeometryObjectDraft,
): boolean {
  const characteristicLength = Math.max(
    geometryCharacteristicLength(left),
    geometryCharacteristicLength(right),
  );
  return sameLengthVector(left, right, "translation", characteristicLength);
}
