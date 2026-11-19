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
  RegionTextureOverridePatch,
} from "./types";
import type { components } from "@/kernel/api/generated/openapi-v2-types";

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
  const authoredRegion = target.kind === "region"
    ? scene?.objects?.find((entry) => entry.id === target.objectId)
        ?.regions?.find((entry) => entry.region_id === target.regionId)
    : undefined;
  const textureOverride = authoredRegion?.texture_override ?? null;
  const regionInitializer = asRecord(textureOverride?.initial_magnetization);
  const regionMagnetizationRef = asNonEmptyString(region?.magnetization_ref);
  const effectiveMagnetizationRef =
    target.kind === "region"
      ? regionMagnetizationRef ?? objectMagnetizationRef
      : objectMagnetizationRef;
  const authoredAsset = target.kind === "region" && regionInitializer
    ? inlineRegionTextureAsset(target.regionId, regionInitializer)
    : null;
  const asset = authoredAsset ?? magnetizationAsset(sceneRecord, effectiveMagnetizationRef);

  return {
    asset,
    assignment: authoredAsset
      ? "region-override"
      : assignmentKind(target, object, asRecord(authoredRegion) ?? region, regionMagnetizationRef),
    authoredRegion: Boolean(authoredRegion),
    regionTextureOverride: textureOverride,
    baseRevision: asFiniteNumber(sceneRecord?.revision),
    effectiveMagnetizationRef: authoredAsset?.id ?? effectiveMagnetizationRef,
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

export function buildRegionTextureOverridePatch(
  asset: MagnetizationAssetDraft | null,
): RegionTextureOverridePatch {
  if (!asset) {
    return { texture_override: null };
  }
  return {
    texture_override: {
      initial_magnetization: {
        kind: "preset_texture",
        mapping: asset.mapping,
        preset_kind: asset.preset_kind ?? asset.kind,
        preset_params: asset.preset_params,
        preset_version: asset.preset_version ?? 1,
        texture_transform: asset.texture_transform,
      } satisfies components["schemas"]["SceneInitialMagnetization"],
    },
  };
}

function inlineRegionTextureAsset(regionId: string, initializer: JsonRecord): MagnetizationAssetDraft {
  const kind = asNonEmptyString(initializer.kind) ?? "unknown";
  const asset: MagnetizationAssetDraft = {
    ...(initializer as JsonObject),
    id: `region-texture:${regionId}`,
    kind,
    name: "Region texture",
  };
  if (kind === "uniform" && Array.isArray(initializer.value)) {
    asset.preset_kind = "uniform";
    asset.preset_params = { direction: initializer.value };
  } else if (kind === "random_seeded" && typeof initializer.seed === "number") {
    asset.preset_kind = "random_seeded";
    asset.preset_params = { seed: initializer.seed };
  }
  return asset;
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
