import type { MagnetizationAsset, SceneDocument } from "../../../lib/session/types";
import { MAGNETIC_PRESET_CATALOG } from "../../../lib/magnetizationPresetCatalog";

export const DEFAULT_TEXTURE_MAPPING = {
  space: "object",
  projection: "object_local",
  clamp_mode: "none",
} as const;

export const DEFAULT_TEXTURE_TRANSFORM = {
  translation: [0, 0, 0] as [number, number, number],
  rotation_quat: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  pivot: [0, 0, 0] as [number, number, number],
} as const;

export function buildMagnetizationAssetFingerprint(args: {
  objectId: string;
  asset: MagnetizationAsset;
}): string {
  const { objectId, asset } = args;
  const presetDescriptor =
    asset.preset_kind != null
      ? MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === asset.preset_kind)
      : null;
  const presetParams =
    asset.kind === "preset_texture" && presetDescriptor
      ? {
          ...presetDescriptor.defaultParams,
          ...(asset.preset_params ?? {}),
        }
      : (asset.preset_params ?? {});
  const mapping = {
    space: asset.mapping?.space ?? DEFAULT_TEXTURE_MAPPING.space,
    projection: asset.mapping?.projection ?? DEFAULT_TEXTURE_MAPPING.projection,
    clamp_mode: asset.mapping?.clamp_mode ?? DEFAULT_TEXTURE_MAPPING.clamp_mode,
  };
  const textureTransform = {
    translation: asset.texture_transform?.translation ?? DEFAULT_TEXTURE_TRANSFORM.translation,
    rotation_quat: asset.texture_transform?.rotation_quat ?? DEFAULT_TEXTURE_TRANSFORM.rotation_quat,
    scale: asset.texture_transform?.scale ?? DEFAULT_TEXTURE_TRANSFORM.scale,
    pivot: asset.texture_transform?.pivot ?? DEFAULT_TEXTURE_TRANSFORM.pivot,
  };
  return JSON.stringify({
    objectId,
    kind: asset.kind,
    value: asset.value ?? null,
    seed: asset.seed ?? null,
    sourcePath: asset.source_path ?? null,
    sourceFormat: asset.source_format ?? null,
    dataset: asset.dataset ?? null,
    sampleIndex: asset.sample_index ?? null,
    presetKind: asset.preset_kind,
    presetParams,
    mapping,
    textureTransform,
  });
}

export function buildSceneMagnetizationFingerprint(
  scene: SceneDocument | null | undefined,
): string | null {
  if (!scene) {
    return null;
  }

  const objectRefs = scene.objects
    .map((object) => ({
      id: object.id,
      name: object.name,
      magnetizationRef: object.magnetization_ref ?? null,
    }))
    .sort((a, b) => `${a.id}\u0000${a.name}`.localeCompare(`${b.id}\u0000${b.name}`));

  const assets = scene.magnetization_assets
    .map((asset) => ({
      id: asset.id,
      name: asset.name,
      fingerprint: buildMagnetizationAssetFingerprint({
        objectId: "__scene_asset__",
        asset,
      }),
    }))
    .sort((a, b) => `${a.id}\u0000${a.name}`.localeCompare(`${b.id}\u0000${b.name}`));

  return JSON.stringify({
    objectRefs,
    assets,
  });
}

export function hasUnsyncedSceneMagnetization(args: {
  localScene: SceneDocument | null | undefined;
  remoteScene: SceneDocument | null | undefined;
}): boolean {
  const localFingerprint = buildSceneMagnetizationFingerprint(args.localScene);
  if (!localFingerprint) return false;
  const remoteFingerprint = buildSceneMagnetizationFingerprint(args.remoteScene);
  // Remote scene not yet fetched: treat as unsynced so the texture is committed before compute.
  if (!remoteFingerprint) return true;
  return localFingerprint !== remoteFingerprint;
}

export function describeMagnetizationApplyState(args: {
  isDirty: boolean;
  isSyncBusy: boolean;
  hasSceneDocument: boolean;
  kind: MagnetizationAsset["kind"];
}): {
  canApply: boolean;
  hint: string;
  disabledReason: string | null;
} {
  const { isDirty, isSyncBusy, hasSceneDocument, kind } = args;
  const subject = kind === "preset_texture" ? "tekstury" : "magnetyzacji";

  if (isSyncBusy) {
    return {
      canApply: false,
      hint: `Trwa synchronizacja ${subject}.`,
      disabledReason: "Poczekaj na zakonczenie biezacej synchronizacji z backendem.",
    };
  }

  if (!hasSceneDocument) {
    return {
      canApply: false,
      hint: `Scena nie jest gotowa do zapisania ${subject}.`,
      disabledReason: "Brakuje aktualnego dokumentu sceny do wyslania na backend.",
    };
  }

  if (!isDirty) {
    return {
      canApply: false,
      hint:
        kind === "preset_texture"
          ? "Brak niezastosowanych zmian tekstury."
          : "Brak niezastosowanych zmian magnetyzacji.",
      disabledReason:
        "Panel nie wykryl jeszcze roznicy wzgledem ostatniego zsynchronizowanego stanu backendu.",
    };
  }

  return {
    canApply: true,
    hint:
      kind === "preset_texture"
        ? "Masz niezastosowane zmiany tekstury."
        : "Masz niezastosowane zmiany magnetyzacji.",
    disabledReason: null,
  };
}
