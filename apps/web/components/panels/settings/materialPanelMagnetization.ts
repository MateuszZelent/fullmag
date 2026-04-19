import type { MagnetizationAsset } from "../../../lib/session/types";

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
  return JSON.stringify({
    objectId,
    assetId: asset.id,
    kind: asset.kind,
    value: asset.value ?? null,
    seed: asset.seed ?? null,
    sourcePath: asset.source_path ?? null,
    sourceFormat: asset.source_format ?? null,
    dataset: asset.dataset ?? null,
    sampleIndex: asset.sample_index ?? null,
    presetKind: asset.preset_kind,
    presetParams: asset.preset_params ?? {},
    mapping: asset.mapping ?? DEFAULT_TEXTURE_MAPPING,
    textureTransform: asset.texture_transform ?? DEFAULT_TEXTURE_TRANSFORM,
  });
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
