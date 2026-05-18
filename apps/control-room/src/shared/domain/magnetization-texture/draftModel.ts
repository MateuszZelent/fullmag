import type {
  JsonObject,
  MagnetizationAssetPatchRequest,
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";

import type {
  MagnetizationAssetDraft,
  MagnetizationAssignmentPatch,
  MagnetizationTextureModel,
  MagnetizationTextureTarget,
} from "./types";

interface ResolveModelInput {
  regionList: RegionListResource | null;
  scene: SceneResource | null;
  target: MagnetizationTextureTarget;
}

interface JsonRecord {
  [key: string]: unknown;
}

export function resolveMagnetizationTextureModel({
  regionList,
  scene,
  target,
}: ResolveModelInput): MagnetizationTextureModel {
  const sceneRecord = asRecord(scene);
  const object = sceneObject(sceneRecord, target.objectId);
  const objectMagnetizationRef = asNonEmptyString(object?.magnetization_ref);
  const region =
    target.kind === "region"
      ? regionResource(regionList, target.regionId)
      : null;
  const regionMagnetizationRef = asNonEmptyString(region?.magnetization_ref);
  const effectiveMagnetizationRef =
    target.kind === "region"
      ? regionMagnetizationRef ?? objectMagnetizationRef
      : objectMagnetizationRef;
  const asset = magnetizationAsset(sceneRecord, effectiveMagnetizationRef);

  return {
    asset,
    assignment: assignmentKind(target, object, region, regionMagnetizationRef),
    baseRevision: asFiniteNumber(sceneRecord?.revision),
    effectiveMagnetizationRef,
    objectMagnetizationRef,
    regionMagnetizationRef,
    target,
  };
}

export function buildMagnetizationAssignmentPatch(
  target: MagnetizationTextureTarget,
  magnetizationRef: string | null,
  baseRevision: number | null,
): MagnetizationAssignmentPatch {
  const normalizedRef = normalizeMagnetizationRef(magnetizationRef);
  if (target.kind === "region") {
    return {
      path: "region",
      payload: { magnetization_ref: normalizedRef },
    };
  }
  return {
    path: "object",
    payload: {
      base_revision: baseRevision,
      magnetization_ref: normalizedRef,
    },
  };
}

export function buildMagnetizationAssetPatch(
  asset: MagnetizationAssetDraft,
  baseRevision: number | null,
): MagnetizationAssetPatchRequest {
  return {
    asset: asset as unknown as JsonObject,
    base_revision: baseRevision,
  };
}

function normalizeMagnetizationRef(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "unassigned" ? trimmed : null;
}

function assignmentKind(
  target: MagnetizationTextureTarget,
  object: JsonRecord | null,
  region: JsonRecord | null,
  regionMagnetizationRef: string | null,
): MagnetizationTextureModel["assignment"] {
  if (!object) return "missing";
  if (target.kind === "object") return "object";
  if (!region) return "missing";
  return regionMagnetizationRef ? "region-override" : "object-inherited";
}

function sceneObject(
  scene: JsonRecord | null,
  objectId: string,
): JsonRecord | null {
  return Array.isArray(scene?.objects)
    ? scene.objects
        .map(asRecord)
        .find((entry) => asNonEmptyString(entry?.id) === objectId) ?? null
    : null;
}

function regionResource(
  regionList: RegionListResource | null,
  regionId: string,
): JsonRecord | null {
  return Array.isArray(regionList?.regions)
    ? regionList.regions
        .map(asRecord)
        .find((entry) => asNonEmptyString(entry?.region_id) === regionId) ??
        null
    : null;
}

function magnetizationAsset(
  scene: JsonRecord | null,
  assetId: string | null,
): MagnetizationAssetDraft | null {
  if (!assetId || !Array.isArray(scene?.magnetization_assets)) return null;
  const asset =
    scene.magnetization_assets
      .map(asRecord)
      .find((entry) => asNonEmptyString(entry?.id) === assetId) ?? null;
  if (!asset) return null;
  const id = asNonEmptyString(asset.id);
  const kind = asNonEmptyString(asset.kind);
  const name = asNonEmptyString(asset.name) ?? id;
  if (!id || !kind || !name) return null;
  return {
    ...(asset as JsonObject),
    id,
    kind,
    name,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
