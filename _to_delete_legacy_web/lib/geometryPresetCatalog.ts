export type GeometryPresetCategory = "primitive" | "component" | "standard_sample";

export type GeometryPresetKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "ring"
  | "nanowire"
  | "thin_film"
  | "pillar"
  | "disk"
  | "mumax_standard_problem_3"
  | "sp4";

export interface GeometryPresetParameter {
  key: string;
  label: string;
  type: "number" | "integer" | "vector3" | "enum" | "boolean";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string | number; label: string }>;
}

export interface GeometryPresetDescriptor {
  kind: GeometryPresetKind;
  label: string;
  category: GeometryPresetCategory;
  icon: string;
  description?: string;
  defaultParams: Record<string, unknown>;
  parameters: GeometryPresetParameter[];
}

export const GEOMETRY_PRESET_CATALOG: GeometryPresetDescriptor[] = [
  {
    kind: "box",
    label: "Box",
    category: "primitive",
    icon: "Cube",
    description: "Standard rectangular cuboid.",
    defaultParams: { dimensions: [100e-9, 50e-9, 10e-9] },
    parameters: [
      { key: "dimensions", label: "Dimensions (X,Y,Z)", type: "vector3", unit: "m" },
    ],
  },
  {
    kind: "cylinder",
    label: "Cylinder",
    category: "primitive",
    icon: "Cylinder",
    defaultParams: { radius: 50e-9, height: 10e-9, axis: "z" },
    parameters: [
      { key: "radius", label: "Radius", type: "number", unit: "m", min: 0 },
      { key: "height", label: "Height", type: "number", unit: "m", min: 0 },
      { key: "axis", label: "Axis", type: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }] },
    ],
  },
  {
    kind: "sphere",
    label: "Sphere",
    category: "primitive",
    icon: "Circle",
    defaultParams: { radius: 50e-9 },
    parameters: [
      { key: "radius", label: "Radius", type: "number", unit: "m", min: 0 },
    ],
  },
  {
    kind: "ring",
    label: "Ring",
    category: "primitive",
    icon: "CircleDashed",
    defaultParams: { outer_radius: 100e-9, inner_radius: 50e-9, height: 10e-9, axis: "z" },
    parameters: [
      { key: "outer_radius", label: "Outer radius", type: "number", unit: "m", min: 0 },
      { key: "inner_radius", label: "Inner radius", type: "number", unit: "m", min: 0 },
      { key: "height", label: "Height", type: "number", unit: "m", min: 0 },
      { key: "axis", label: "Axis", type: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }] },
    ],
  },
  {
    kind: "nanowire",
    label: "Nanowire",
    category: "component",
    icon: "Minus",
    description: "Long cylindrical or rectangular wire.",
    defaultParams: { length: 1000e-9, width: 20e-9, height: 5e-9, axis: "x" },
    parameters: [
      { key: "length", label: "Length", type: "number", unit: "m", min: 0 },
      { key: "width", label: "Width", type: "number", unit: "m", min: 0 },
      { key: "height", label: "Height / Thickness", type: "number", unit: "m", min: 0 },
      { key: "axis", label: "Long axis", type: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }] },
    ],
  },
  {
    kind: "thin_film",
    label: "Thin Film",
    category: "component",
    icon: "Square",
    description: "Extended thin rectangular film.",
    defaultParams: { length: 1000e-9, width: 1000e-9, thickness: 1e-9 },
    parameters: [
      { key: "length", label: "Length", type: "number", unit: "m", min: 0 },
      { key: "width", label: "Width", type: "number", unit: "m", min: 0 },
      { key: "thickness", label: "Thickness", type: "number", unit: "m", min: 0 },
    ],
  },
  {
    kind: "pillar",
    label: "Pillar",
    category: "component",
    icon: "AlignVerticalSpaceAround",
    defaultParams: { radius: 30e-9, height: 100e-9 },
    parameters: [
      { key: "radius", label: "Radius", type: "number", unit: "m", min: 0 },
      { key: "height", label: "Height", type: "number", unit: "m", min: 0 },
    ],
  },
  {
    kind: "disk",
    label: "Disk",
    category: "component",
    icon: "Disc",
    defaultParams: { radius: 100e-9, thickness: 5e-9 },
    parameters: [
      { key: "radius", label: "Radius", type: "number", unit: "m", min: 0 },
      { key: "thickness", label: "Thickness", type: "number", unit: "m", min: 0 },
    ],
  },
  {
    kind: "mumax_standard_problem_3",
    label: "Standard Problem 3",
    category: "standard_sample",
    icon: "BookOpen",
    description: "Standard micromagnetic problem 3 (cubic).",
    defaultParams: { dimensions: [100e-9, 100e-9, 100e-9] },
    parameters: [
      { key: "dimensions", label: "Dimensions", type: "vector3", unit: "m" },
    ],
  },
  {
    kind: "sp4",
    label: "Standard Problem 4",
    category: "standard_sample",
    icon: "BookOpen",
    description: "Standard micromagnetic problem 4 (thin film).",
    defaultParams: { length: 500e-9, width: 125e-9, thickness: 3e-9 },
    parameters: [
      { key: "length", label: "Length", type: "number", unit: "m", min: 0 },
      { key: "width", label: "Width", type: "number", unit: "m", min: 0 },
      { key: "thickness", label: "Thickness", type: "number", unit: "m", min: 0 },
    ],
  },
];

export function evaluateGeometryPreset(
  presetKind: GeometryPresetKind,
  params: Record<string, unknown>,
): { geometry_kind: string; geometry_params: Record<string, unknown> } {
  switch (presetKind) {
    case "box":
    case "mumax_standard_problem_3":
      return {
        geometry_kind: "Box",
        geometry_params: { size: params.dimensions ?? [100e-9, 50e-9, 10e-9] },
      };
    case "cylinder":
      return {
        geometry_kind: "Cylinder",
        geometry_params: {
          radius: params.radius ?? 50e-9,
          height: params.height ?? 10e-9,
          // We can map axis in the future if we support different orientations in the backend. 
          // For now, Fullmag cylinder is primitive on Z-axis natively except via rotation.
          // In builder we can translate and rotate.
        },
      };
    case "sphere":
      return {
        geometry_kind: "Ellipsoid",
        geometry_params: {
          rx: params.radius ?? 50e-9,
          ry: params.radius ?? 50e-9,
          rz: params.radius ?? 50e-9,
        },
      };
    case "ring":
      return {
        geometry_kind: "Difference",
        geometry_params: {
          base: {
            geometry_kind: "Cylinder",
            geometry_params: { radius: params.outer_radius ?? 100e-9, height: params.height ?? 10e-9 },
          },
          tool: {
            geometry_kind: "Cylinder",
            geometry_params: { radius: params.inner_radius ?? 50e-9, height: (params.height as number ?? 10e-9) * 2 },
          },
        },
      };
    case "nanowire":
      // assuming a box-based nanowire for now, depending on axis
      const nL = (params.length as number) ?? 1000e-9;
      const nW = (params.width as number) ?? 20e-9;
      const nH = (params.height as number) ?? 5e-9;
      const nAxis = params.axis ?? "x";
      const sizeAxisN =
        nAxis === "x" ? [nL, nW, nH] : nAxis === "y" ? [nW, nL, nH] : [nW, nH, nL];
      return {
        geometry_kind: "Box",
        geometry_params: { size: sizeAxisN },
      };
    case "thin_film":
    case "sp4":
      return {
        geometry_kind: "Box",
        geometry_params: {
          size: [
            (params.length as number) ?? 1000e-9,
            (params.width as number) ?? 1000e-9,
            (params.thickness as number) ?? 1e-9,
          ],
        },
      };
    case "pillar":
      return {
        geometry_kind: "Cylinder",
        geometry_params: {
          radius: params.radius ?? 30e-9,
          height: params.height ?? 100e-9,
        },
      };
    case "disk":
      return {
        geometry_kind: "Cylinder",
        geometry_params: {
          radius: params.radius ?? 100e-9,
          height: params.thickness ?? 5e-9,
        },
      };
    default:
      return {
        geometry_kind: "Box",
        geometry_params: { size: [20e-9, 20e-9, 10e-9] },
      };
  }
}
