export type CanonicalMagnetizationTexturePresetId =
  | "uniform"
  | "random"
  | "vortex"
  | "antivortex"
  | "bloch_skyrmion"
  | "neel_skyrmion"
  | "antiskyrmion"
  | "skyrmionium"
  | "bimeron"
  | "skyrmion_lattice"
  | "domain_wall"
  | "two_domain"
  | "vortex_wall"
  | "artificial_spin_ice"
  | "helical"
  | "conical"
  | "spiral"
  | "hopfion"
  | "hopfion_compact_support"
  | "bloch_point";

export type MagnetizationTexturePresetId =
  | CanonicalMagnetizationTexturePresetId
  | "random_seeded";

export type MagnetizationTextureCategoryId =
  | "all"
  | "uniform_random"
  | "vortices_skyrmions"
  | "domains_walls"
  | "helices_cones"
  | "topological_3d";

export interface MagnetizationTextureCategory {
  id: MagnetizationTextureCategoryId;
  label: string;
  shortLabel: string;
}

export const MAGNETIZATION_TEXTURE_CATEGORIES: readonly MagnetizationTextureCategory[] = [
  { id: "all", label: "All", shortLabel: "All" },
  { id: "uniform_random", label: "Uniform & random", shortLabel: "Uniform & rnd" },
  { id: "vortices_skyrmions", label: "Vortices & skyrmions", shortLabel: "Vortices & skyrmions" },
  { id: "domains_walls", label: "Domains & walls", shortLabel: "Domains & walls" },
  { id: "helices_cones", label: "Helices & cones", shortLabel: "Helices & cones" },
  { id: "topological_3d", label: "3D topological", shortLabel: "3D topological" },
] as const;

export interface MagnetizationTexturePreset {
  category: Exclude<MagnetizationTextureCategoryId, "all">;
  defaultParams: Record<string, unknown>;
  description: string;
  id: MagnetizationTexturePresetId;
  label: string;
}

export const MAGNETIZATION_TEXTURE_PRESETS: readonly MagnetizationTexturePreset[] = [
  {
    category: "uniform_random",
    defaultParams: { direction: [1, 0, 0] },
    description: "Spatially uniform unit magnetization vector across the active mask.",
    id: "uniform",
    label: "Uniform",
  },
  {
    category: "uniform_random",
    defaultParams: { seed: 1 },
    description: "Deterministic SplitMix64 isotropic unit-sphere random spin state.",
    id: "random",
    label: "Random seeded",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: { plane: "xy", circulation: 1, core_polarity: 1, core_radius: 8e-9 },
    description: "Closed in-plane flux-closure circulation with a Gaussian out-of-plane core.",
    id: "vortex",
    label: "Vortex",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: { plane: "xy", circulation: 1, core_polarity: 1, core_radius: 8e-9 },
    description: "Saddle-point topological defect (winding q = -1) with Gaussian core.",
    id: "antivortex",
    label: "Antivortex",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: { plane: "xy", radius: 25e-9, wall_width: 5e-9, core_polarity: -1, chirality: 1 },
    description: "Chiral helical skyrmion stabilized by bulk Dzyaloshinskii-Moriya interaction.",
    id: "bloch_skyrmion",
    label: "Bloch skyrmion",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: { plane: "xy", radius: 25e-9, wall_width: 5e-9, core_polarity: -1, chirality: 1 },
    description: "Radial hedgehog skyrmion stabilized by interfacial DMI.",
    id: "neel_skyrmion",
    label: "Néel skyrmion",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: { plane: "xy", radius: 25e-9, wall_width: 5e-9, core_polarity: -1, chirality: 1 },
    description: "Anisotropic D2d antiskyrmion with alternating Bloch and Néel wall segments.",
    id: "antiskyrmion",
    label: "Antiskyrmion",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: {
      plane: "xy",
      inner_radius: 16e-9,
      outer_radius: 34e-9,
      wall_width: 4e-9,
      kind: "neel",
      chirality: 1,
      background_sign: 1,
    },
    description: "Target 2π-skyrmion (Q = 0) formed by concentric opposite-polarity rings.",
    id: "skyrmionium",
    label: "Skyrmionium",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: {
      plane: "xy",
      radius: 25e-9,
      wall_width: 5e-9,
      vorticity: 1,
      helicity_rad: 0,
      background_sign: 1,
    },
    description: "Coupled meron-antimeron pair embedded in an easy-plane background.",
    id: "bimeron",
    label: "Bimeron",
  },
  {
    category: "vortices_skyrmions",
    defaultParams: {
      plane: "xy",
      lattice: "hexagonal",
      lattice_constant: 33e-9,
      radius: 10e-9,
      wall_width: 2.5e-9,
      kind: "bloch",
      core_polarity: -1,
      chirality: 1,
    },
    description: "Periodic hexagonal (Abrikosov C6) or square (C4) skyrmion crystal.",
    id: "skyrmion_lattice",
    label: "Skyrmion lattice",
  },
  {
    category: "domains_walls",
    defaultParams: {
      normal_axis: "x",
      center_offset: 0.0,
      width: 10e-9,
      left: [0, 1, 0],
      right: [0, -1, 0],
      kind: "neel",
    },
    description: "Analytical 180° tanh/sech Néel or Bloch domain wall.",
    id: "domain_wall",
    label: "Domain wall",
  },
  {
    category: "domains_walls",
    defaultParams: {
      normal_axis: "x",
      left: [1, 0, 0],
      right: [-1, 0, 0],
      wall: [0, 1, 0],
      sharp: true,
    },
    description: "Arbitrary-angle two-domain state with sharp step or smooth tanh boundary.",
    id: "two_domain",
    label: "Two-domain",
  },
  {
    category: "domains_walls",
    defaultParams: {
      plane: "xy",
      wall_half_width: 25e-9,
      left_mx: 1,
      right_mx: -1,
      circulation: -1,
      core_polarity: 1,
      core_radius: 1e-9,
    },
    description: "Head-to-head or tail-to-tail nanowire domain wall with a central vortex pocket.",
    id: "vortex_wall",
    label: "Vortex wall",
  },
  {
    category: "domains_walls",
    defaultParams: {
      plane: "xy",
      lattice: "square",
      vertex_state: "type_i_ground",
      pitch: 25e-9,
    },
    description: "Square or kagome artificial spin ice obeying vertex ice-rule ordering.",
    id: "artificial_spin_ice",
    label: "Artificial spin ice",
  },
  {
    category: "helices_cones",
    defaultParams: {
      wavevector: [1.2566370614359173e8, 0, 0],
      e1: [0, 1, 0],
      e2: [0, 0, 1],
      phase_rad: 0.0,
    },
    description: "Harmonic proper-screw Bloch helix or Néel cycloid with orthonormal basis.",
    id: "helical",
    label: "Helical",
  },
  {
    category: "helices_cones",
    defaultParams: {
      wavevector: [1.2566370614359173e8, 0, 0],
      cone_axis: [1, 0, 0],
      phase_rad: 0.0,
      cone_angle_rad: Math.PI / 4,
    },
    description: "Conical spin spiral precessing around a symmetry axis at opening half-angle β.",
    id: "conical",
    label: "Conical",
  },
  {
    category: "helices_cones",
    defaultParams: {
      spiral_kind: "cycloidal",
      wavelength: 50e-9,
      propagation_axis: [1, 0, 0],
      spin_plane_normal: [0, 1, 0],
      chirality: 1,
      phase_rad: 0.0,
    },
    description: "Generalized cycloidal, proper-screw, or tilted spin spiral parameterized by pitch λ.",
    id: "spiral",
    label: "Spiral",
  },
  {
    category: "topological_3d",
    defaultParams: {
      radius: 25e-9,
      hopf_charge: 1,
      background_sign: 1,
      axial_scale: 1,
      phase_rad: 0,
    },
    description: "Three-dimensional stereographic Hopf soliton with linked preimage fibers.",
    id: "hopfion",
    label: "Hopfion",
  },
  {
    category: "topological_3d",
    defaultParams: { major_radius: 28e-9, minor_radius: 8e-9 },
    description: "Toroidal Hopfion with exact compact support (+Z outside the minor tube).",
    id: "hopfion_compact_support",
    label: "Hopfion (compact)",
  },
  {
    category: "topological_3d",
    defaultParams: {
      bp_kind: "circulating",
      polarity: 1,
      twist_rad: Math.PI / 2,
      core_radius: 1e-9,
    },
    description: "Three-dimensional radial, circulating, or hyperbolic Bloch point singularity.",
    id: "bloch_point",
    label: "Bloch point",
  },
] as const;

const LEGACY_RANDOM_SEEDED_PRESET: MagnetizationTexturePreset = {
  category: "uniform_random",
  defaultParams: { seed: 1 },
  description: "Legacy alias for deterministic SplitMix64 random spin state.",
  id: "random_seeded",
  label: "Random seeded (legacy)",
};

const PRESET_BY_ID = new Map<string, MagnetizationTexturePreset>(
  MAGNETIZATION_TEXTURE_PRESETS.map((preset) => [preset.id, preset]),
);

export function isMagnetizationTexturePresetId(
  value: unknown,
): value is MagnetizationTexturePresetId {
  return (
    typeof value === "string" &&
    (PRESET_BY_ID.has(value) || value === "random_seeded")
  );
}

export function canonicalPresetKind(
  presetId: string | null | undefined,
): CanonicalMagnetizationTexturePresetId {
  if (!presetId || presetId === "random_seeded") {
    return presetId === "random_seeded" ? "random" : "uniform";
  }
  return PRESET_BY_ID.has(presetId)
    ? (presetId as CanonicalMagnetizationTexturePresetId)
    : "uniform";
}

export function humanPresetLabel(
  presetId: string | null | undefined,
  assetKind?: string | null,
): string {
  if (assetKind === "sampled" || assetKind === "file" || assetKind === "sampled_field") {
    return "Field file";
  }
  if (presetId === "random_seeded") {
    return "Random seeded";
  }
  const found = presetId ? PRESET_BY_ID.get(presetId) : undefined;
  if (found) return found.label;
  if (assetKind === "uniform") return "Uniform";
  if (assetKind === "random_seeded" || assetKind === "random") return "Random seeded";
  return "Unassigned";
}

export function magnetizationTexturePresetOptions(
  currentPresetId: MagnetizationTexturePresetId,
): readonly MagnetizationTexturePreset[] {
  return currentPresetId === "random_seeded"
    ? [...MAGNETIZATION_TEXTURE_PRESETS, LEGACY_RANDOM_SEEDED_PRESET]
    : MAGNETIZATION_TEXTURE_PRESETS;
}
