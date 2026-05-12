import type { ObjectPatchRequest, SceneResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

interface JsonRecord {
  [key: string]: unknown;
}

export interface ObjectMagneticTexturePanelModel {
  assetId: string;
  assetKind: string;
  assetLabel: string;
  baseRevision: number | null;
  mapping: string;
  mode: "committed" | "missing";
  objectId: string;
  presetKind: string;
  textureTransform: string;
}

export interface ObjectMagneticTextureDraft {
  magnetizationRef: string;
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

function selectedObjectId(selection: Selection): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
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

function magnetizationAsset(
  scene: SceneResource | null,
  assetId: string | null,
): JsonRecord | null {
  if (!assetId) return null;
  const sceneRecord = asRecord(scene);
  return Array.isArray(sceneRecord?.magnetization_assets)
    ? sceneRecord.magnetization_assets
        .map(asRecord)
        .find((entry) => asString(entry?.id) === assetId) ?? null
    : null;
}

function formatJson(value: unknown): string {
  if (!value || typeof value !== "object") return "not configured";
  return JSON.stringify(value, null, 2);
}

export function normalizeMagnetizationRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unassigned") return null;
  return trimmed;
}

export function resolveObjectMagneticTexturePanelModel(
  selection: Selection,
  scene: SceneResource | null,
): ObjectMagneticTexturePanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);
  const assetId = asString(object?.magnetization_ref);
  const asset = magnetizationAsset(scene, assetId);
  const assetKind = asString(asset?.kind) ?? "unassigned";
  const assetLabel =
    asString(asset?.ui_label) ??
    asString(asset?.name) ??
    asString(asset?.preset_kind) ??
    assetId ??
    "unassigned";

  if (!object || !objectId) {
    return {
      assetId: "unassigned",
      assetKind: "unassigned",
      assetLabel: "unassigned",
      baseRevision: revision,
      mapping: "not configured",
      mode: "missing",
      objectId: objectId ?? "none",
      presetKind: "unassigned",
      textureTransform: "not configured",
    };
  }

  return {
    assetId: assetId ?? "unassigned",
    assetKind,
    assetLabel,
    baseRevision: revision,
    mapping: formatJson(asset?.mapping),
    mode: "committed",
    objectId,
    presetKind: asString(asset?.preset_kind) ?? "unassigned",
    textureTransform: formatJson(asset?.texture_transform),
  };
}

export function objectMagneticTextureDraftFromModel(
  model: ObjectMagneticTexturePanelModel,
): ObjectMagneticTextureDraft {
  return {
    magnetizationRef: model.assetId === "unassigned" ? "" : model.assetId,
  };
}

export function objectMagneticTextureDraftKey(
  model: ObjectMagneticTexturePanelModel,
): string {
  return [
    model.objectId,
    model.assetId,
    model.assetKind,
    model.baseRevision ?? "unknown",
  ].join(":");
}

export function buildMagnetizationAssignmentPatch(
  draft: ObjectMagneticTextureDraft,
  baseRevision: number | null,
): ObjectPatchRequest {
  return {
    base_revision: baseRevision,
    magnetization_ref: normalizeMagnetizationRef(draft.magnetizationRef),
  };
}
