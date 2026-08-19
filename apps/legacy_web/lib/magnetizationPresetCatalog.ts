export type MagneticPresetKind =
  | "uniform"
  | "random"
  | "random_seeded"
  | "vortex"
  | "antivortex"
  | "bloch_skyrmion"
  | "neel_skyrmion"
  | "bimeron"
  | "domain_wall"
  | "two_domain"
  | "helical"
  | "conical";

/**
 * Presets whose parameters are physical metric quantities (meters).
 * For these presets, auto-fit should adjust `preset_params` (radius, width, etc.)
 * rather than `texture_transform.scale`, because scaling the coordinate system
 * breaks the physical meaning of metric parameters.
 */
export const METRIC_ANALYTIC_PRESETS: ReadonlySet<MagneticPresetKind> = new Set([
  "vortex",
  "antivortex",
  "bloch_skyrmion",
  "neel_skyrmion",
  "bimeron",
  "domain_wall",
]);

export interface MagneticPresetParameter {
  key: string;
  label: string;
  type: "number" | "integer" | "vector3" | "enum" | "boolean";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string | number; label: string }>;
}

export interface MagneticPresetDescriptor {
  kind: MagneticPresetKind;
  label: string;
  category: "basic" | "topological" | "domains" | "periodic";
  icon: string;
  previewProxy: "none" | "disc" | "box" | "cylinder" | "wall" | "wave";
  defaultParams: Record<string, unknown>;
  parameters: MagneticPresetParameter[];
}

export const MAGNETIC_PRESET_CATALOG: MagneticPresetDescriptor[] = [
  {
    kind: "uniform",
    label: "Uniform",
    category: "basic",
    icon: "◢",
    previewProxy: "none",
    defaultParams: { direction: [1, 0, 0] },
    parameters: [
      { key: "direction", label: "Direction", type: "vector3" },
    ],
  },
  {
    kind: "random",
    label: "Random",
    category: "basic",
    icon: "⋯",
    previewProxy: "none",
    defaultParams: { seed: 1 },
    parameters: [
      { key: "seed", label: "Seed", type: "integer", min: 1, step: 1 },
    ],
  },
  {
    kind: "vortex",
    label: "Vortex",
    category: "topological",
    icon: "🌀",
    previewProxy: "disc",
    defaultParams: { circulation: 1, core_polarity: 1, core_radius: 1e-9, plane: "xy" },
    parameters: [
      { key: "circulation", label: "Circulation", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "core_polarity", label: "Core polarity", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "core_radius", label: "Core radius", type: "number", unit: "m", min: 0 },
      { key: "plane", label: "Plane", type: "enum", options: [{ value: "xy", label: "XY" }, { value: "xz", label: "XZ" }, { value: "yz", label: "YZ" }] },
    ],
  },
  {
    kind: "antivortex",
    label: "Antivortex",
    category: "topological",
    icon: "🌀",
    previewProxy: "disc",
    defaultParams: { core_polarity: 1, core_radius: 1e-9, plane: "xy" },
    parameters: [
      { key: "core_polarity", label: "Core polarity", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "core_radius", label: "Core radius", type: "number", unit: "m", min: 0 },
      { key: "plane", label: "Plane", type: "enum", options: [{ value: "xy", label: "XY" }, { value: "xz", label: "XZ" }, { value: "yz", label: "YZ" }] },
    ],
  },
  {
    kind: "bloch_skyrmion",
    label: "Bloch skyrmion",
    category: "topological",
    icon: "◎",
    previewProxy: "disc",
    defaultParams: { radius: 35e-9, wall_width: 10e-9, chirality: 1, core_polarity: -1, plane: "xy" },
    parameters: [
      { key: "radius", label: "Radius", type: "number", unit: "m", min: 0 },
      { key: "wall_width", label: "Wall width", type: "number", unit: "m", min: 0 },
      { key: "chirality", label: "Chirality", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "core_polarity", label: "Core polarity", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "plane", label: "Plane", type: "enum", options: [{ value: "xy", label: "XY" }, { value: "xz", label: "XZ" }, { value: "yz", label: "YZ" }] },
    ],
  },
  {
    kind: "neel_skyrmion",
    label: "Néel skyrmion",
    category: "topological",
    icon: "◉",
    previewProxy: "disc",
    defaultParams: { radius: 35e-9, wall_width: 10e-9, chirality: 1, core_polarity: -1, plane: "xy" },
    parameters: [
      { key: "radius", label: "Radius", type: "number", unit: "m", min: 0 },
      { key: "wall_width", label: "Wall width", type: "number", unit: "m", min: 0 },
      { key: "chirality", label: "Chirality", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "core_polarity", label: "Core polarity", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "plane", label: "Plane", type: "enum", options: [{ value: "xy", label: "XY" }, { value: "xz", label: "XZ" }, { value: "yz", label: "YZ" }] },
    ],
  },
  {
    kind: "bimeron",
    label: "Bimeron",
    category: "topological",
    icon: "◈",
    previewProxy: "disc",
    defaultParams: {
      plane: "xy",
      radius: 10e-9,
      wall_width: 2e-9,
      vorticity: 1,
      helicity_rad: 0,
      background_sign: 1,
    },
    parameters: [
      { key: "radius", label: "Radius", type: "number", unit: "m", min: 0 },
      { key: "wall_width", label: "Wall width", type: "number", unit: "m", min: 0 },
      { key: "vorticity", label: "Vorticity", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "helicity_rad", label: "Helicity", type: "number", unit: "rad" },
      { key: "background_sign", label: "Background sign", type: "integer", options: [{ value: 1, label: "+1" }, { value: -1, label: "-1" }] },
      { key: "plane", label: "Plane", type: "enum", options: [{ value: "xy", label: "XY" }, { value: "xz", label: "XZ" }, { value: "yz", label: "YZ" }] },
    ],
  },
  {
    kind: "domain_wall",
    label: "Domain wall",
    category: "domains",
    icon: "║",
    previewProxy: "wall",
    defaultParams: { kind: "neel", width: 10e-9, center_offset: 0, normal_axis: "x", left: [1, 0, 0], right: [-1, 0, 0], wall_center_direction: [0, 1, 0] },
    parameters: [
      { key: "kind", label: "Type", type: "enum", options: [{ value: "neel", label: "Néel" }, { value: "bloch", label: "Bloch" }] },
      { key: "width", label: "Width", type: "number", unit: "m", min: 0 },
      { key: "center_offset", label: "Center offset", type: "number", unit: "m" },
      { key: "normal_axis", label: "Normal axis", type: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }] },
      { key: "left", label: "Left direction", type: "vector3" },
      { key: "right", label: "Right direction", type: "vector3" },
    ],
  },
  {
    kind: "two_domain",
    label: "Two domains",
    category: "domains",
    icon: "⊟",
    previewProxy: "wall",
    defaultParams: { left: [1, 0, 0], right: [-1, 0, 0], sharp: true, wall: [0, 1, 0], normal_axis: "x" },
    parameters: [
      { key: "left", label: "Left domain", type: "vector3" },
      { key: "right", label: "Right domain", type: "vector3" },
      { key: "wall", label: "Wall direction", type: "vector3" },
      { key: "normal_axis", label: "Normal axis", type: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }] },
    ],
  },
  {
    kind: "helical",
    label: "Helical",
    category: "periodic",
    icon: "≈",
    previewProxy: "wave",
    defaultParams: { wavevector: [1e7, 0, 0], e1: [1, 0, 0], e2: [0, 1, 0], phase_rad: 0 },
    parameters: [
      { key: "wavevector", label: "Wavevector", type: "vector3" },
      { key: "e1", label: "Basis e1", type: "vector3" },
      { key: "e2", label: "Basis e2", type: "vector3" },
      { key: "phase_rad", label: "Phase", type: "number", unit: "rad" },
    ],
  },
  {
    kind: "conical",
    label: "Conical",
    category: "periodic",
    icon: "⌁",
    previewProxy: "wave",
    defaultParams: { wavevector: [1e7, 0, 0], cone_axis: [0, 0, 1], cone_angle_rad: Math.PI / 4, phase_rad: 0 },
    parameters: [
      { key: "wavevector", label: "Wavevector", type: "vector3" },
      { key: "cone_axis", label: "Cone axis", type: "vector3" },
      { key: "cone_angle_rad", label: "Cone angle", type: "number", unit: "rad", min: 0, max: Math.PI },
      { key: "phase_rad", label: "Phase", type: "number", unit: "rad" },
    ],
  },
];
