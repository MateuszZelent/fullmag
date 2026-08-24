export type MagnetizationTexturePresetId =
  | "uniform"
  | "random"
  | "random_seeded"
  | "vortex"
  | "antivortex"
  | "bloch_skyrmion"
  | "neel_skyrmion"
  | "antiskyrmion"
  | "skyrmionium"
  | "bimeron"
  | "domain_wall"
  | "two_domain"
  | "vortex_wall"
  | "helical"
  | "conical"
  | "hopfion"
  | "hopfion_compact_support";

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
    id: "random",
    label: "Random seeded",
  },
  {
    defaultParams: { plane: "xy", circulation: 1, core_polarity: 1, core_radius: 1e-9 },
    id: "vortex",
    label: "Vortex",
  },
  {
    defaultParams: { plane: "xy", circulation: 1, core_polarity: 1, core_radius: 1e-9 },
    id: "antivortex",
    label: "Antivortex",
  },
  {
    defaultParams: { plane: "xy", radius: 10e-9, wall_width: 2e-9, core_polarity: -1, chirality: 1 },
    id: "bloch_skyrmion",
    label: "Bloch Skyrmion",
  },
  {
    defaultParams: { plane: "xy", radius: 10e-9, wall_width: 2e-9, core_polarity: -1, chirality: 1 },
    id: "neel_skyrmion",
    label: "Néel Skyrmion",
  },
  {
    defaultParams: { plane: "xy", radius: 10e-9, wall_width: 2e-9, core_polarity: -1, chirality: 1 },
    id: "antiskyrmion",
    label: "Antiskyrmion",
  },
  {
    defaultParams: { plane: "xy", inner_radius: 8e-9, outer_radius: 16e-9, wall_width: 2e-9, kind: "neel", chirality: 1, background_sign: 1 },
    id: "skyrmionium",
    label: "Skyrmionium",
  },
  {
    defaultParams: { plane: "xy", radius: 10e-9, wall_width: 2e-9, vorticity: 1, helicity_rad: 0, background_sign: 1 },
    id: "bimeron",
    label: "Bimeron",
  },
  {
    defaultParams: { normal_axis: "x", center_offset: 0.0, width: 10e-9, left: [1, 0, 0], right: [-1, 0, 0], kind: "neel" },
    id: "domain_wall",
    label: "Domain Wall",
  },
  {
    defaultParams: { normal_axis: "x", left: [1, 0, 0], right: [-1, 0, 0], wall: [0, 1, 0] },
    id: "two_domain",
    label: "Two Domain",
  },
  {
    defaultParams: { plane: "xy", wall_half_width: 25e-9, left_mx: 1, right_mx: -1, circulation: 1, core_polarity: 1, core_radius: 2e-9 },
    id: "vortex_wall",
    label: "Vortex Wall",
  },
  {
    defaultParams: { wavevector: [1, 0, 0], e1: [1, 0, 0], e2: [0, 1, 0], phase_rad: 0.0 },
    id: "helical",
    label: "Helical",
  },
  {
    defaultParams: { wavevector: [1, 0, 0], cone_axis: [0, 0, 1], phase_rad: 0.0, cone_angle_rad: 0.785398 },
    id: "conical",
    label: "Conical",
  },
  {
    defaultParams: { radius: 20e-9, hopf_charge: 1, background_sign: 1, axial_scale: 1, phase_rad: 0 },
    id: "hopfion",
    label: "Hopfion",
  },
  {
    defaultParams: { major_radius: 20e-9, minor_radius: 8e-9 },
    id: "hopfion_compact_support",
    label: "Hopfion (Compact Support)",
  },
] as const;
