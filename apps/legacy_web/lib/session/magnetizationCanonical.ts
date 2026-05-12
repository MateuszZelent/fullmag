import type {
  MagnetizationAsset,
  ScriptBuilderMagnetizationEntry,
  TextureTransform3D,
} from "./types";

export const DEFAULT_MAGNETIZATION_MAPPING = {
  space: "object",
  projection: "object_local",
  clamp_mode: "none",
} as const;

export const DEFAULT_MAGNETIZATION_TEXTURE_TRANSFORM = {
  translation: [0, 0, 0] as [number, number, number],
  rotation_quat: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  pivot: [0, 0, 0] as [number, number, number],
} as const;

const DEFAULT_UNIFORM_DIRECTION: [number, number, number] = [1, 0, 0];

function normalizeVec3(
  value: number[] | readonly number[] | null | undefined,
  fallback: [number, number, number],
): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    return [...fallback];
  }
  return [
    Number.isFinite(Number(value[0])) ? Number(value[0]) : fallback[0],
    Number.isFinite(Number(value[1])) ? Number(value[1]) : fallback[1],
    Number.isFinite(Number(value[2])) ? Number(value[2]) : fallback[2],
  ];
}

function cloneMapping(
  mapping: MagnetizationAsset["mapping"] | ScriptBuilderMagnetizationEntry["mapping"] | null | undefined,
) {
  return {
    space: mapping?.space === "world" ? "world" : DEFAULT_MAGNETIZATION_MAPPING.space,
    projection: mapping?.projection ?? DEFAULT_MAGNETIZATION_MAPPING.projection,
    clamp_mode: mapping?.clamp_mode ?? DEFAULT_MAGNETIZATION_MAPPING.clamp_mode,
  };
}

function cloneTextureTransform(
  transform:
    | MagnetizationAsset["texture_transform"]
    | ScriptBuilderMagnetizationEntry["texture_transform"]
    | null
    | undefined,
): TextureTransform3D {
  return {
    translation: normalizeVec3(
      transform?.translation,
      DEFAULT_MAGNETIZATION_TEXTURE_TRANSFORM.translation,
    ),
    rotation_quat:
      Array.isArray(transform?.rotation_quat) && transform.rotation_quat.length >= 4
        ? ([
            Number(transform.rotation_quat[0] ?? 0),
            Number(transform.rotation_quat[1] ?? 0),
            Number(transform.rotation_quat[2] ?? 0),
            Number(transform.rotation_quat[3] ?? 1),
          ] as [number, number, number, number])
        : [...DEFAULT_MAGNETIZATION_TEXTURE_TRANSFORM.rotation_quat],
    scale: normalizeVec3(
      transform?.scale,
      DEFAULT_MAGNETIZATION_TEXTURE_TRANSFORM.scale,
    ),
    pivot: normalizeVec3(
      transform?.pivot,
      DEFAULT_MAGNETIZATION_TEXTURE_TRANSFORM.pivot,
    ),
  };
}

function buildUniformPresetParams(
  value: number[] | readonly number[] | null | undefined,
  fallbackDirection: [number, number, number],
): Record<string, unknown> {
  return {
    direction: normalizeVec3(value, fallbackDirection),
  };
}

function buildRandomPresetParams(
  seed: number | null | undefined,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const legacySeed = typeof existing?.seed === "number" ? existing.seed : null;
  return {
    seed: seed ?? legacySeed ?? 1,
  };
}

export function buildDefaultScriptBuilderMagnetization(
  direction: [number, number, number] = [0, 0, 1],
): ScriptBuilderMagnetizationEntry {
  return {
    kind: "preset_texture",
    value: null,
    seed: null,
    source_path: null,
    source_format: null,
    dataset: null,
    sample_index: null,
    mapping: { ...DEFAULT_MAGNETIZATION_MAPPING },
    texture_transform: { ...DEFAULT_MAGNETIZATION_TEXTURE_TRANSFORM },
    preset_kind: "uniform",
    preset_params: { direction: [...direction] },
    preset_version: 1,
    ui_label: "Uniform",
  };
}

export function buildDefaultMagnetizationAsset(
  name: string,
  direction: [number, number, number] = [0, 0, 1],
): MagnetizationAsset {
  return {
    id: `mag:${name}`,
    name: `${name} magnetization`,
    kind: "preset_texture",
    value: null,
    seed: null,
    source_path: null,
    source_format: null,
    dataset: null,
    sample_index: null,
    mapping: { ...DEFAULT_MAGNETIZATION_MAPPING },
    texture_transform: { ...DEFAULT_MAGNETIZATION_TEXTURE_TRANSFORM },
    preset_kind: "uniform",
    preset_params: { direction: [...direction] },
    preset_version: 1,
    ui_label: "Uniform",
  };
}

export function normalizeScriptBuilderMagnetization(
  magnetization: ScriptBuilderMagnetizationEntry,
): ScriptBuilderMagnetizationEntry {
  const kind =
    magnetization.kind === "file" &&
    (magnetization.dataset != null || magnetization.sample_index != null)
      ? "sampled"
      : magnetization.kind;
  if (kind === "uniform") {
    return {
      ...buildDefaultScriptBuilderMagnetization(
        normalizeVec3(magnetization.value, DEFAULT_UNIFORM_DIRECTION),
      ),
      mapping: cloneMapping(magnetization.mapping),
      texture_transform: cloneTextureTransform(magnetization.texture_transform),
      preset_params: buildUniformPresetParams(
        magnetization.value,
        DEFAULT_UNIFORM_DIRECTION,
      ),
      ui_label: magnetization.ui_label ?? "Uniform",
      preset_version: magnetization.preset_version ?? 1,
    };
  }
  if (kind === "random" || kind === "random_seeded") {
    return {
      kind: "preset_texture",
      value: null,
      seed: null,
      source_path: null,
      source_format: null,
      dataset: null,
      sample_index: null,
      mapping: cloneMapping(magnetization.mapping),
      texture_transform: cloneTextureTransform(magnetization.texture_transform),
      preset_kind: "random",
      preset_params: buildRandomPresetParams(
        magnetization.seed,
        magnetization.preset_params,
      ),
      preset_version: magnetization.preset_version ?? 1,
      ui_label: magnetization.ui_label ?? "Random",
    };
  }
  if (kind === "preset_texture") {
    const presetKind = magnetization.preset_kind ?? "uniform";
    const presetParams =
      presetKind === "uniform"
        ? buildUniformPresetParams(
            Array.isArray(magnetization.preset_params?.direction)
              ? (magnetization.preset_params.direction as number[])
              : magnetization.value,
            DEFAULT_UNIFORM_DIRECTION,
          )
        : presetKind === "random" || presetKind === "random_seeded"
          ? buildRandomPresetParams(magnetization.seed, magnetization.preset_params)
          : (magnetization.preset_params ?? {});
    return {
      kind: "preset_texture",
      value: null,
      seed: null,
      source_path: null,
      source_format: null,
      dataset: null,
      sample_index: null,
      mapping: cloneMapping(magnetization.mapping),
      texture_transform: cloneTextureTransform(magnetization.texture_transform),
      preset_kind: presetKind,
      preset_params: presetParams,
      preset_version: magnetization.preset_version ?? 1,
      ui_label:
        magnetization.ui_label
        ?? (presetKind === "random" || presetKind === "random_seeded" ? "Random" : presetKind === "uniform" ? "Uniform" : null),
    };
  }
  const canonicalKind = kind === "file" ? "sampled" : kind;
  return {
    kind: canonicalKind,
    value: null,
    seed: null,
    source_path: magnetization.source_path ?? null,
    source_format: magnetization.source_format ?? null,
    dataset: magnetization.dataset ?? null,
    sample_index: magnetization.sample_index ?? null,
    mapping: cloneMapping(magnetization.mapping),
    texture_transform: cloneTextureTransform(magnetization.texture_transform),
    preset_kind: null,
    preset_params: null,
    preset_version: null,
    ui_label: magnetization.ui_label ?? null,
  };
}

export function normalizeMagnetizationAsset(asset: MagnetizationAsset): MagnetizationAsset {
  const normalized = normalizeScriptBuilderMagnetization({
    kind: asset.kind,
    value: asset.value,
    seed: asset.seed,
    source_path: asset.source_path,
    source_format: asset.source_format,
    dataset: asset.dataset,
    sample_index: asset.sample_index,
    mapping: asset.mapping,
    texture_transform: asset.texture_transform,
    preset_kind: asset.preset_kind,
    preset_params: asset.preset_params,
    preset_version: asset.preset_version,
    ui_label: asset.ui_label,
  });
  return {
    id: asset.id,
    name: asset.name,
    kind: normalized.kind,
    value: normalized.value,
    seed: normalized.seed,
    source_path: normalized.source_path ?? null,
    source_format: normalized.source_format ?? null,
    dataset: normalized.dataset ?? null,
    sample_index: normalized.sample_index ?? null,
    mapping: cloneMapping(normalized.mapping),
    texture_transform: cloneTextureTransform(normalized.texture_transform),
    preset_kind: normalized.preset_kind ?? null,
    preset_params: normalized.preset_params ?? null,
    preset_version: normalized.preset_version ?? null,
    ui_label: normalized.ui_label ?? null,
  };
}
