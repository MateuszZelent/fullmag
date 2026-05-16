export interface TextureTransform3D {
  translation: [number, number, number];
  rotation_quat: [number, number, number, number];
  scale: [number, number, number];
  pivot: [number, number, number];
}

/**
 * Scale semantics for texture transforms.
 *
 * - `"size_multiplier"` — Non-metric presets (uniform, random, helical, conical, two_domain).
 *   `scale` carries the spatial extent; the planner uses it to map texture coordinates
 *   onto geometry.
 *
 * - `"identity_metric"` — Metric analytic presets (vortex, skyrmion, domain_wall).
 *   Physical dimensions are encoded in `preset_params` (radius, wall_width, etc.);
 *   `scale` MUST remain `[1, 1, 1]` to avoid double-scaling in the planner.
 */
export type TextureScaleSemantics = "size_multiplier" | "identity_metric";

/** Metric presets whose physical dimensions live in preset_params, not scale. */
const METRIC_PRESET_KINDS = new Set([
  "vortex",
  "antivortex",
  "bloch_skyrmion",
  "neel_skyrmion",
  "domain_wall",
]);

/** Determine whether a preset kind uses scale as a size multiplier or identity. */
export function textureScaleSemantics(presetKind: string): TextureScaleSemantics {
  return METRIC_PRESET_KINDS.has(presetKind) ? "identity_metric" : "size_multiplier";
}

export const IDENTITY_TEXTURE_TRANSFORM: TextureTransform3D = {
  translation: [0, 0, 0],
  rotation_quat: [0, 0, 0, 1],
  scale: [1, 1, 1],
  pivot: [0, 0, 0],
};

export function cloneTextureTransform(value: TextureTransform3D): TextureTransform3D {
  return {
    translation: [...value.translation] as [number, number, number],
    rotation_quat: [...value.rotation_quat] as [number, number, number, number],
    scale: [...value.scale] as [number, number, number],
    pivot: [...value.pivot] as [number, number, number],
  };
}

export function resetTextureTransform(): TextureTransform3D {
  return cloneTextureTransform(IDENTITY_TEXTURE_TRANSFORM);
}

export function fitTextureToBounds(
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
): TextureTransform3D {
  const sx = Math.max(boundsMax[0] - boundsMin[0], 1e-18);
  const sy = Math.max(boundsMax[1] - boundsMin[1], 1e-18);
  const sz = Math.max(boundsMax[2] - boundsMin[2], 1e-18);
  const center: [number, number, number] = [
    0.5 * (boundsMin[0] + boundsMax[0]),
    0.5 * (boundsMin[1] + boundsMax[1]),
    0.5 * (boundsMin[2] + boundsMax[2]),
  ];
  return {
    translation: center,
    rotation_quat: [0, 0, 0, 1],
    scale: [sx, sy, sz],
    pivot: [0, 0, 0],
  };
}

/**
 * For metric analytic presets, fit the preset parameters to geometry bounds
 * instead of abusing texture_transform.scale.
 *
 * Returns a new set of preset_params with physical dimensions adjusted
 * to match the target bounds, plus a metric-safe texture transform
 * (translation + pivot centered on bounds, scale = identity).
 */
export function fitPresetParamsToBounds(
  presetKind: string,
  params: Record<string, unknown>,
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
): { params: Record<string, unknown>; transform: TextureTransform3D } {
  const ex = Math.abs(boundsMax[0] - boundsMin[0]);
  const ey = Math.abs(boundsMax[1] - boundsMin[1]);
  const ez = Math.abs(boundsMax[2] - boundsMin[2]);
  const center: [number, number, number] = [
    0.5 * (boundsMin[0] + boundsMax[0]),
    0.5 * (boundsMin[1] + boundsMax[1]),
    0.5 * (boundsMin[2] + boundsMax[2]),
  ];

  // Metric-safe transform: only center, no scale distortion
  const transform: TextureTransform3D = {
    translation: center,
    rotation_quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
    pivot: [0, 0, 0],
  };

  const plane = (params.plane as string) ?? "xy";
  const inPlaneExtents = _inPlaneExtents(ex, ey, ez, plane);
  const minInPlane = Math.min(inPlaneExtents[0], inPlaneExtents[1]);
  const normalExtent = _normalExtent(ex, ey, ez, plane);

  const next = { ...params };

  switch (presetKind) {
    case "vortex":
    case "antivortex":
      next.core_radius = 0.12 * minInPlane;
      break;

    case "bloch_skyrmion":
    case "neel_skyrmion":
      next.radius = 0.40 * minInPlane;
      next.wall_width = 0.10 * minInPlane;
      break;

    case "domain_wall": {
      const axis = (params.normal_axis as string) ?? "x";
      const extentAlongNormal =
        axis === "x" ? ex : axis === "y" ? ey : ez;
      next.center_offset = 0;
      next.width = 0.12 * extentAlongNormal;
      break;
    }

    default:
      // Non-metric presets (uniform, random, helical, conical, two_domain)
      // fall through — no parameter adjustment needed.
      break;
  }

  return { params: next, transform };
}

function _inPlaneExtents(
  ex: number,
  ey: number,
  ez: number,
  plane: string,
): [number, number] {
  if (plane === "xz") return [ex, ez];
  if (plane === "yz") return [ey, ez];
  return [ex, ey]; // "xy" default
}

function _normalExtent(
  ex: number,
  ey: number,
  ez: number,
  plane: string,
): number {
  if (plane === "xz") return ey;
  if (plane === "yz") return ex;
  return ez; // "xy" default
}

/* ── Texture Projection Mode ────────────────────────────────────── */

/**
 * Enumeration of supported texture projection modes.
 *
 * Kept in sync with the Rust IR (`TextureMappingIR.projection`)
 * and the MaterialPanel dropdown.
 */
export type TextureProjectionMode =
  | "object_local"
  | "planar_xy"
  | "planar_xz"
  | "planar_yz";

export const TEXTURE_PROJECTION_MODES: readonly {
  label: string;
  value: TextureProjectionMode;
}[] = [
  { label: "Object Local", value: "object_local" },
  { label: "Planar XY", value: "planar_xy" },
  { label: "Planar XZ", value: "planar_xz" },
  { label: "Planar YZ", value: "planar_yz" },
] as const;
