export type MagnetizationTexturePresetId = "random_seeded" | "uniform" | "vortex";

export interface MagnetizationTexturePreset {
  defaultParams: Record<string, unknown>;
  id: MagnetizationTexturePresetId;
  label: string;
}

export const MAGNETIZATION_TEXTURE_PRESETS: readonly MagnetizationTexturePreset[] = [
  {
    defaultParams: { direction: [1, 0, 0] },
    id: "uniform",
    label: "Uniform",
  },
  {
    defaultParams: { seed: 1 },
    id: "random_seeded",
    label: "Random seeded",
  },
  {
    defaultParams: { chirality: 1, polarity: 1 },
    id: "vortex",
    label: "Vortex",
  },
] as const;

export function texturePresetById(
  id: string | null | undefined,
): MagnetizationTexturePreset | null {
  return (
    MAGNETIZATION_TEXTURE_PRESETS.find((preset) => preset.id === id) ?? null
  );
}
