import type {
  JsonObject,
  ObjectPatchRequest,
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  magnetizationTextureAssetId,
  presetMagnetizationAsset,
} from "@/modules/magnetization-texture/assetFactory";
import { resolveMagnetizationTextureModel } from "@/modules/magnetization-texture/draftModel";
import { resolveMagnetizationTextureTarget } from "@/modules/magnetization-texture/targetResolver";
import type { MagnetizationTexturePresetId } from "@/modules/magnetization-texture/texturePresets";
import type { MagnetizationAssetDraft } from "@/modules/magnetization-texture/types";

interface JsonRecord {
  [key: string]: unknown;
}

export interface ObjectMagneticTexturePanelModel {
  assignment: string;
  asset: MagnetizationAssetDraft | null;
  assetId: string;
  assetKind: string;
  assetLabel: string;
  baseRevision: number | null;
  mapping: string;
  mode: "committed" | "missing";
  objectId: string;
  presetKind: string;
  regionId: string | null;
  targetKind: "object" | "region";
  textureTransform: string;
}

export interface ObjectMagneticTextureDraft {
  assetLabel: string;
  chirality: string;
  clampMode: string;
  directionX: string;
  directionY: string;
  directionZ: string;
  magnetizationRef: string;
  mappingProjection: string;
  mappingSpace: string;
  pivotX: string;
  pivotY: string;
  pivotZ: string;
  polarity: string;
  presetKind: MagnetizationTexturePresetId;
  rotationXDeg: string;
  rotationYDeg: string;
  rotationZDeg: string;
  scaleX: string;
  scaleY: string;
  scaleZ: string;
  seed: string;
  translationX: string;
  translationY: string;
  translationZ: string;
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

function asPresetKind(value: unknown): MagnetizationTexturePresetId | null {
  return value === "uniform" || value === "random_seeded" || value === "vortex"
    ? value
    : null;
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

function formatJson(value: unknown): string {
  if (!value || typeof value !== "object") return "not configured";
  return JSON.stringify(value, null, 2);
}

function vectorFromRecord(
  record: JsonRecord | null,
  key: string,
  fallback: [number, number, number],
): [number, number, number] {
  const value = record?.[key];
  if (!Array.isArray(value)) return fallback;
  const numbers = value.map(asNumber);
  return numbers.length >= 3 && numbers.slice(0, 3).every((entry) => entry !== null)
    ? ([numbers[0], numbers[1], numbers[2]] as [number, number, number])
    : fallback;
}

function quatFromRecord(
  record: JsonRecord | null,
  key: string,
): [number, number, number, number] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [0, 0, 0, 1];
  const numbers = value.map(asNumber);
  return numbers.length >= 4 && numbers.slice(0, 4).every((entry) => entry !== null)
    ? ([numbers[0], numbers[1], numbers[2], numbers[3]] as [
        number,
        number,
        number,
        number,
      ])
    : [0, 0, 0, 1];
}

function numberText(value: number): string {
  const rounded = Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(6));
  return String(rounded);
}

function vec3Text(
  value: [number, number, number],
): [string, string, string] {
  return [numberText(value[0]), numberText(value[1]), numberText(value[2])];
}

function quatToEulerDegrees(
  quat: [number, number, number, number],
): [number, number, number] {
  const [x, y, z, w] = quat;
  const roll = Math.atan2(
    2 * (w * x + y * z),
    1 - 2 * (x * x + y * y),
  );
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(
    2 * (w * z + x * y),
    1 - 2 * (y * y + z * z),
  );
  return [roll, pitch, yaw].map((radians) => (radians * 180) / Math.PI) as [
    number,
    number,
    number,
  ];
}

function eulerDegreesToQuat(
  euler: [number, number, number],
): [number, number, number, number] {
  const [roll, pitch, yaw] = euler.map((degrees) => (degrees * Math.PI) / 180);
  const cx = Math.cos(roll / 2);
  const sx = Math.sin(roll / 2);
  const cy = Math.cos(pitch / 2);
  const sy = Math.sin(pitch / 2);
  const cz = Math.cos(yaw / 2);
  const sz = Math.sin(yaw / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

function requiredNumber(value: string | undefined, label: string): number {
  const trimmed = value?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return parsed;
}

function requiredInteger(value: string | undefined, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

function stringOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function normalizeMagnetizationRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unassigned") return null;
  return trimmed;
}

export function resolveObjectMagneticTexturePanelModel(
  selection: Selection,
  scene: SceneResource | null,
  regionList: RegionListResource | null = null,
): ObjectMagneticTexturePanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);
  const regionId =
    selection.ref?.type === "scene-object" ? selection.ref.regionId ?? null : null;
  const target = resolveMagnetizationTextureTarget({
    kind: selection.kind,
    objectId,
    regionId,
  });

  if (!object || !objectId || !target) {
    return {
      assignment: "missing",
      asset: null,
      assetId: "unassigned",
      assetKind: "unassigned",
      assetLabel: "unassigned",
      baseRevision: revision,
      mapping: "not configured",
      mode: "missing",
      objectId: objectId ?? "none",
      presetKind: "unassigned",
      regionId: regionId ?? null,
      targetKind: target?.kind ?? "object",
      textureTransform: "not configured",
    };
  }

  const textureModel = resolveMagnetizationTextureModel({
    regionList,
    scene,
    target,
  });
  const asset = textureModel.asset;
  const assetId = textureModel.effectiveMagnetizationRef;
  const assetKind = asString(asset?.kind) ?? "unassigned";
  const assetLabel =
    asString(asset?.ui_label) ??
    asString(asset?.name) ??
    asString(asset?.preset_kind) ??
    assetId ??
    "unassigned";

  return {
    assignment: textureModel.assignment,
    asset,
    assetId: assetId ?? "unassigned",
    assetKind,
    assetLabel,
    baseRevision: revision,
    mapping: formatJson(asset?.mapping),
    mode: "committed",
    objectId,
    presetKind: asString(asset?.preset_kind) ?? "unassigned",
    regionId: target.kind === "region" ? target.regionId : null,
    targetKind: target.kind,
    textureTransform: formatJson(asset?.texture_transform),
  };
}

export function objectMagneticTextureDraftFromModel(
  model: ObjectMagneticTexturePanelModel,
): ObjectMagneticTextureDraft {
  const asset = model.asset;
  const mapping = asRecord(asset?.mapping);
  const params = asRecord(asset?.preset_params);
  const transform = asRecord(asset?.texture_transform);
  const presetKind = asPresetKind(model.presetKind) ?? "uniform";
  const direction = vec3Text(vectorFromRecord(params, "direction", [1, 0, 0]));
  const translation = vec3Text(
    vectorFromRecord(transform, "translation", [0, 0, 0]),
  );
  const rotation = vec3Text(
    quatToEulerDegrees(quatFromRecord(transform, "rotation_quat")),
  );
  const scale = vec3Text(vectorFromRecord(transform, "scale", [1, 1, 1]));
  const pivot = vec3Text(vectorFromRecord(transform, "pivot", [0, 0, 0]));

  return {
    assetLabel: model.assetLabel === "unassigned" ? "" : model.assetLabel,
    chirality: numberText(asNumber(params?.chirality) ?? 1),
    clampMode: asString(mapping?.clamp_mode) ?? "none",
    directionX: direction[0],
    directionY: direction[1],
    directionZ: direction[2],
    magnetizationRef: model.assetId === "unassigned" ? "" : model.assetId,
    mappingProjection: asString(mapping?.projection) ?? "object_local",
    mappingSpace: asString(mapping?.space) ?? "object",
    pivotX: pivot[0],
    pivotY: pivot[1],
    pivotZ: pivot[2],
    polarity: numberText(asNumber(params?.polarity) ?? 1),
    presetKind,
    rotationXDeg: rotation[0],
    rotationYDeg: rotation[1],
    rotationZDeg: rotation[2],
    scaleX: scale[0],
    scaleY: scale[1],
    scaleZ: scale[2],
    seed: numberText(asNumber(params?.seed) ?? 1),
    translationX: translation[0],
    translationY: translation[1],
    translationZ: translation[2],
  };
}

export function objectMagneticTextureDraftKey(
  model: ObjectMagneticTexturePanelModel,
): string {
  return [
    model.objectId,
    model.assetId,
    model.assetKind,
    model.regionId ?? "object",
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

export function buildObjectMagneticTextureAssetDraft(
  model: ObjectMagneticTexturePanelModel,
  draft: ObjectMagneticTextureDraft,
): MagnetizationAssetDraft {
  if (model.mode !== "committed") {
    throw new Error("No committed scene object.");
  }

  const presetKind = asPresetKind(draft.presetKind) ?? "uniform";
  const target =
    model.targetKind === "region" && model.regionId
      ? {
          kind: "region" as const,
          objectId: model.objectId,
          regionId: model.regionId,
        }
      : { kind: "object" as const, objectId: model.objectId };
  const assetId =
    normalizeMagnetizationRef(draft.magnetizationRef) ??
    magnetizationTextureAssetId(target, presetKind);
  const label = stringOrDefault(draft.assetLabel, defaultLabel(presetKind));
  const asset = presetMagnetizationAsset({
    id: assetId,
    label,
    mapping: {
      clamp_mode: stringOrDefault(draft.clampMode, "none"),
      projection: stringOrDefault(draft.mappingProjection, "object_local"),
      space: stringOrDefault(draft.mappingSpace, "object"),
    },
    presetKind,
    presetParams: presetParamsFromDraft(presetKind, draft),
    textureTransform: {
      pivot: [
        requiredNumber(draft.pivotX, "Pivot X"),
        requiredNumber(draft.pivotY, "Pivot Y"),
        requiredNumber(draft.pivotZ, "Pivot Z"),
      ],
      rotation_quat: eulerDegreesToQuat([
        requiredNumber(draft.rotationXDeg, "Rotation X"),
        requiredNumber(draft.rotationYDeg, "Rotation Y"),
        requiredNumber(draft.rotationZDeg, "Rotation Z"),
      ]),
      scale: [
        requiredNumber(draft.scaleX, "Scale X"),
        requiredNumber(draft.scaleY, "Scale Y"),
        requiredNumber(draft.scaleZ, "Scale Z"),
      ],
      translation: [
        requiredNumber(draft.translationX, "Translation X"),
        requiredNumber(draft.translationY, "Translation Y"),
        requiredNumber(draft.translationZ, "Translation Z"),
      ],
    },
  });

  return asset as unknown as MagnetizationAssetDraft;
}

function presetParamsFromDraft(
  presetKind: MagnetizationTexturePresetId,
  draft: ObjectMagneticTextureDraft,
): JsonObject {
  if (presetKind === "random_seeded") {
    return {
      seed: requiredInteger(draft.seed, "Random seed"),
    };
  }

  if (presetKind === "vortex") {
    return {
      chirality: requiredNumber(draft.chirality, "Chirality"),
      polarity: requiredNumber(draft.polarity, "Polarity"),
    };
  }

  return {
    direction: [
      requiredNumber(draft.directionX, "Direction X"),
      requiredNumber(draft.directionY, "Direction Y"),
      requiredNumber(draft.directionZ, "Direction Z"),
    ],
  };
}

function defaultLabel(presetKind: MagnetizationTexturePresetId): string {
  if (presetKind === "uniform") return "Uniform texture";
  if (presetKind === "random_seeded") return "Random seeded texture";
  return "Vortex texture";
}
