import type { JsonObject } from "@/kernel/api/apiTypes";

import type { TargetMetricBounds, Vec3 } from "./boundsResolver";
import {
  axisAngleToQuaternion,
  eulerDegreesToQuaternion,
  fallbackDomainWallDirection,
  normalizeQuaternion,
  quaternionToAxisAngle,
  quaternionToEulerDegrees,
  type PresetTextureSpecV2,
  type Quat4,
  type TextureAxisExtentModeV2,
  type TextureClampModeV2,
  type TextureMappingSpaceMode,
  type TextureProjectionModeV2,
} from "./evaluateV2Client";
import {
  canonicalPresetKind,
  humanPresetLabel,
  isMagnetizationTexturePresetId,
  type MagnetizationTexturePresetId,
} from "./texturePresets";

export type MagneticTextureSourceMode = "preset" | "field-file";
export type RegionTextureInheritanceMode = "inherit" | "override";
export type PlaneSelectionMode = "auto" | "xy" | "xz" | "yz";
export type WaveSpecificationMode = "wavelength_axis" | "wavevector";
export type WallCenterDirectionMode = "auto" | "custom";
export type RotationRepresentationMode = "euler_xyz" | "axis_angle";
export type RotateVectorsMode = "space_and_spins" | "space_only";
export type TranslationUnitMode = "nm" | "um" | "mm" | "m" | "bounds_pct" | "bounds_norm";
export type PivotPresetMode = "object_center" | "region_center" | "world_origin" | "custom";
export type FieldInterpolationMode = "exact" | "nearest" | "trilinear";

export interface MagneticTextureDraft {
  [key: string]: unknown;

  // 1. Identity & source mode
  inheritanceMode: RegionTextureInheritanceMode;
  sourceMode: MagneticTextureSourceMode;
  customUiLabel: string;
  presetVersion: 1 | 2;
  presetKind: MagnetizationTexturePresetId;

  // 2. Shared plane / axis orientation
  planeMode: PlaneSelectionMode;
  resolvedPlane: "xy" | "xz" | "yz";
  normalAxis: "x" | "y" | "z";

  // 3. Analytic preset parameters in SI (m, rad, 1/m, dimensionless)
  direction: Vec3;
  seed: number;
  circulation: -1 | 1;
  circulationAuto: boolean;
  corePolarity: -1 | 1;
  chirality: -1 | 1;
  vorticity: -1 | 1;
  backgroundSign: -1 | 1;
  hopfCharge: -1 | 1;
  wallKind: "neel" | "bloch";
  coreRadiusM: number;
  radiusM: number;
  innerRadiusM: number;
  outerRadiusM: number;
  wallWidthM: number;
  wallHalfWidthM: number;
  centerOffsetM: number;
  leftDomain: Vec3;
  rightDomain: Vec3;
  lockAntiparallelRight: boolean;
  wallCenterMode: WallCenterDirectionMode;
  wallCenterDirection: Vec3;
  twoDomainSharp: boolean;
  leftMxSign: -1 | 1;
  rightMxSign: -1 | 1;
  helicityRad: number;
  waveMode: WaveSpecificationMode;
  wavelengthM: number;
  propagationAxis: Vec3;
  wavevectorPerM: Vec3;
  e1: Vec3;
  e2: Vec3;
  coneAxis: Vec3;
  coneAngleRad: number;
  phaseRad: number;
  axialScale: number;
  majorRadiusM: number;
  minorRadiusM: number;

  // Extended Wave-2 preset parameters
  latticeSymmetry: "hexagonal" | "square";
  latticeConstantM: number;
  spiralKind: "cycloidal" | "proper_screw" | "custom_plane";
  spinPlaneNormal: Vec3;
  bpKind: "radial" | "circulating" | "hyperbolic";
  bpPolarity: -1 | 1;
  bpTwistRad: number;
  asiLattice: "square" | "kagome";
  asiVertexState: "type_i_ground" | "type_ii_polarized" | "monopole_pair";
  asiPitchM: number;

  // 4. Placement & Transform in Target
  translationM: Vec3;
  translationUnitMode: TranslationUnitMode;
  rotationMode: RotationRepresentationMode;
  eulerDeg: Vec3;
  axisAngleAxis: Vec3;
  axisAngleDeg: number;
  rotationQuat: Quat4;
  rotateVectorsMode: RotateVectorsMode;
  scale: Vec3;
  uniformScaleLocked: boolean;
  pivotMode: PivotPresetMode;
  pivotM: Vec3;

  // 5. Coordinate Mapping & Bounds
  mappingSpace: TextureMappingSpaceMode;
  clampMode: TextureClampModeV2;
  tilePeriodM: Vec3;
  backgroundVector: Vec3;
  axisExtentMode: TextureAxisExtentModeV2;
  axisThicknessM: number;

  // 6. Field File (sampled_field)
  fieldOrigin: "artifact" | "file";
  fieldArtifactRef: string;
  fieldSourcePath: string;
  fieldSourceFormat: "auto" | "field_state_json" | "zarr" | "h5" | "ovf" | "npz";
  fieldDataset: string;
  fieldSampleIndex: number;
  fieldInterpolation: FieldInterpolationMode;
  fieldRenormalize: boolean;
  fieldZeroNormThreshold: number;
}

export const THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS = new Set<string>([
  "hopfion",
  "hopfion_compact_support",
  "bloch_point",
]);

export const DIMENSIONLESS_SCALE_METRIC_ERROR =
  "Scale is a dimensionless multiplier around 1.0 — set physical nm dimensions in Preset Parameters above.";

const MIN_METRIC_LENGTH_M = 5e-10; // 0.5 nm

export function roundSig3(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_METRIC_LENGTH_M;
  const clamped = Math.max(MIN_METRIC_LENGTH_M, value);
  return Number(clamped.toPrecision(3));
}

export function resolveLargestFacePlane(size: readonly [number, number, number]): "xy" | "xz" | "yz" {
  const [lx, ly, lz] = size;
  const areaXY = lx * ly;
  const areaXZ = lx * lz;
  const areaYZ = ly * lz;
  if (areaXY >= areaXZ && areaXY >= areaYZ) return "xy";
  if (areaXZ >= areaYZ) return "xz";
  return "yz";
}

export function resolveLongestAxis(size: readonly [number, number, number]): {
  axis: "x" | "y" | "z";
  index: 0 | 1 | 2;
  length: number;
} {
  const [lx, ly, lz] = size;
  if (lx >= ly && lx >= lz) return { axis: "x", index: 0, length: lx };
  if (ly >= lz) return { axis: "y", index: 1, length: ly };
  return { axis: "z", index: 2, length: lz };
}

export function planeInPlaneDimensions(
  size: readonly [number, number, number],
  plane: "xy" | "xz" | "yz",
): [number, number, number] {
  if (plane === "xy") return [size[0], size[1], size[2]];
  if (plane === "xz") return [size[0], size[2], size[1]];
  return [size[1], size[2], size[0]];
}

export function synchronizePlaneAndProjection(
  presetKind: string,
  planeMode: PlaneSelectionMode,
  explicitPlane: "xy" | "xz" | "yz",
  currentProjection: TextureProjectionModeV2 | string,
  bounds: TargetMetricBounds,
): { resolvedPlane: "xy" | "xz" | "yz"; mappingProjection: TextureProjectionModeV2 } {
  if (THREE_DIMENSIONAL_OBJECT_LOCAL_PRESETS.has(presetKind)) {
    return { resolvedPlane: "xy", mappingProjection: "object_local" };
  }
  const resolvedPlane =
    planeMode === "auto" ? resolveLargestFacePlane(bounds.size) : explicitPlane;
  const mappingProjection: TextureProjectionModeV2 =
    currentProjection === "object_local" || !currentProjection
      ? "object_local"
      : (`planar_${resolvedPlane}` as TextureProjectionModeV2);
  return { resolvedPlane, mappingProjection };
}

export const syncPlaneAndProjection = synchronizePlaneAndProjection;

function axisUnitVector(axis: "x" | "y" | "z"): Vec3 {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  return [0, 0, 1];
}

function blochHelixBasisForAxis(axis: "x" | "y" | "z"): { e1: Vec3; e2: Vec3 } {
  if (axis === "x") return { e1: [0, 1, 0], e2: [0, 0, 1] };
  if (axis === "y") return { e1: [0, 0, 1], e2: [1, 0, 0] };
  return { e1: [1, 0, 0], e2: [0, 1, 0] };
}

function defaultDomainPairForNormal(axis: "x" | "y" | "z"): { left: Vec3; right: Vec3 } {
  if (axis === "x") return { left: [0, 1, 0], right: [0, -1, 0] };
  if (axis === "y") return { left: [1, 0, 0], right: [-1, 0, 0] };
  return { left: [1, 0, 0], right: [-1, 0, 0] };
}

export function computeRelativePresetDefaults(
  presetKind: MagnetizationTexturePresetId,
  bounds: TargetMetricBounds,
): Record<string, unknown> {
  const kind = canonicalPresetKind(presetKind);
  const plane = resolveLargestFacePlane(bounds.size);
  const [lu, lv] = planeInPlaneDimensions(bounds.size, plane);
  const lMin = Math.min(lu, lv);
  const longest = resolveLongestAxis(bounds.size);
  const l3dXy = Math.min(bounds.size[0], bounds.size[1]);
  const lz = bounds.size[2];

  const coreInit = roundSig3(Math.max(1e-9, Math.min(0.08 * lMin, 15e-9)));
  const skyrmionR = roundSig3(0.25 * lMin);
  const skyrmionWall = roundSig3(0.05 * lMin);
  const wavelength = roundSig3(0.5 * longest.length);
  const qHat = axisUnitVector(longest.axis);
  const qMag = (2.0 * Math.PI) / wavelength;
  const wavevector: Vec3 = [qHat[0] * qMag, qHat[1] * qMag, qHat[2] * qMag];

  switch (kind) {
    case "uniform":
      return { direction: [1, 0, 0] };
    case "random":
      return { seed: 1 };
    case "vortex":
    case "antivortex":
      return {
        plane,
        circulation: 1,
        core_polarity: 1,
        core_radius: coreInit,
      };
    case "bloch_skyrmion":
    case "neel_skyrmion":
    case "antiskyrmion":
      return {
        plane,
        radius: skyrmionR,
        wall_width: skyrmionWall,
        core_polarity: -1,
        chirality: 1,
      };
    case "skyrmionium": {
      const innerR = roundSig3(0.16 * lMin);
      const outerR = Math.max(roundSig3(0.34 * lMin), innerR * 1.5);
      return {
        plane,
        inner_radius: innerR,
        outer_radius: outerR,
        wall_width: roundSig3(0.04 * lMin),
        kind: "neel",
        chirality: 1,
        background_sign: 1,
      };
    }
    case "bimeron":
      return {
        plane,
        radius: skyrmionR,
        wall_width: skyrmionWall,
        vorticity: 1,
        helicity_rad: 0,
        background_sign: 1,
      };
    case "skyrmion_lattice": {
      const rLat = roundSig3(0.1 * lMin);
      const aLat = Math.max(roundSig3(0.33 * lMin), 2.5 * rLat);
      return {
        plane,
        lattice: "hexagonal",
        lattice_constant: aLat,
        radius: rLat,
        wall_width: roundSig3(0.025 * lMin),
        kind: "bloch",
        core_polarity: -1,
        chirality: 1,
      };
    }
    case "domain_wall": {
      const { left, right } = defaultDomainPairForNormal(longest.axis);
      return {
        normal_axis: longest.axis,
        center_offset: 0,
        width: roundSig3(0.1 * longest.length),
        left,
        right,
        kind: "neel",
      };
    }
    case "two_domain":
      return {
        normal_axis: longest.axis,
        left: [1, 0, 0],
        right: [-1, 0, 0],
        wall: longest.axis === "y" ? [0, 0, 1] : [0, 1, 0],
        sharp: true,
      };
    case "vortex_wall":
      return {
        plane,
        wall_half_width: roundSig3(0.25 * lMin),
        left_mx: 1,
        right_mx: -1,
        circulation: -1,
        core_polarity: 1,
        core_radius: coreInit,
      };
    case "artificial_spin_ice":
      return {
        plane,
        lattice: "square",
        vertex_state: "type_i_ground",
        pitch: roundSig3(0.25 * lMin),
      };
    case "helical": {
      const { e1, e2 } = blochHelixBasisForAxis(longest.axis);
      return {
        wavevector,
        e1,
        e2,
        phase_rad: 0,
      };
    }
    case "conical":
      return {
        wavevector,
        cone_axis: qHat,
        cone_angle_rad: Math.PI / 4,
        phase_rad: 0,
      };
    case "spiral":
      return {
        spiral_kind: "cycloidal",
        wavelength,
        propagation_axis: qHat,
        spin_plane_normal: longest.axis === "y" ? [0, 0, 1] : [0, 1, 0],
        chirality: 1,
        phase_rad: 0,
      };
    case "hopfion": {
      const axial = Math.max(0.2, Math.min(2.0, Number((lz / Math.max(l3dXy, 1e-12)).toPrecision(3))));
      return {
        radius: roundSig3(0.25 * l3dXy),
        hopf_charge: 1,
        background_sign: 1,
        axial_scale: axial,
        phase_rad: 0,
      };
    }
    case "hopfion_compact_support": {
      const majorR = roundSig3(0.28 * l3dXy);
      const minorR = Math.min(roundSig3(Math.min(0.12 * l3dXy, 0.45 * lz)), majorR);
      return {
        major_radius: majorR,
        minor_radius: minorR,
      };
    }
    case "bloch_point":
      return {
        bp_kind: "circulating",
        polarity: 1,
        twist_rad: Math.PI / 2,
        core_radius: 1e-9,
      };
  }
}

function defaultTranslationUnitForBounds(bounds: TargetMetricBounds): TranslationUnitMode {
  const maxDim = Math.max(bounds.size[0], bounds.size[1], bounds.size[2]);
  if (maxDim < 10e-6) return "nm";
  if (maxDim < 1e-3) return "um";
  if (maxDim < 1) return "mm";
  return "m";
}

export function createDefaultMagneticTextureDraft(
  presetKind: MagnetizationTexturePresetId = "uniform",
  bounds: TargetMetricBounds,
  hostContext: "object" | "region" | "stage" = "object",
): MagneticTextureDraft {
  const plane = resolveLargestFacePlane(bounds.size);
  const [lu, lv] = planeInPlaneDimensions(bounds.size, plane);
  const lMin = Math.min(lu, lv);
  const longest = resolveLongestAxis(bounds.size);
  const l3dXy = Math.min(bounds.size[0], bounds.size[1]);
  const lz = bounds.size[2];

  const wavelengthM = roundSig3(0.5 * longest.length);
  const qHat = axisUnitVector(longest.axis);
  const qMag = (2.0 * Math.PI) / wavelengthM;
  const { e1, e2 } = blochHelixBasisForAxis(longest.axis);
  const { left: dwLeft, right: dwRight } = defaultDomainPairForNormal(longest.axis);
  const majorR = roundSig3(0.28 * l3dXy);
  const minorR = Math.min(roundSig3(Math.min(0.12 * l3dXy, 0.45 * lz)), majorR);
  const rLat = roundSig3(0.1 * lMin);
  const aLat = Math.max(roundSig3(0.33 * lMin), 2.5 * rLat);

  const mappingSpace: TextureMappingSpaceMode = hostContext === "region" ? "region" : "object";
  const initialTranslation: Vec3 =
    mappingSpace === "region" ? [0, 0, 0] : [...bounds.localCenter];

  return {
    inheritanceMode: hostContext === "region" ? "inherit" : "override",
    sourceMode: "preset",
    customUiLabel: "",
    presetVersion: 2,
    presetKind: canonicalPresetKind(presetKind),

    planeMode: "auto",
    resolvedPlane: plane,
    normalAxis: longest.axis,

    direction: [1, 0, 0],
    seed: 1,
    circulation: 1,
    circulationAuto: true,
    corePolarity:
      presetKind === "bloch_skyrmion" ||
      presetKind === "neel_skyrmion" ||
      presetKind === "antiskyrmion" ||
      presetKind === "skyrmion_lattice"
        ? -1
        : 1,
    chirality: 1,
    vorticity: 1,
    backgroundSign: 1,
    hopfCharge: 1,
    wallKind: presetKind === "skyrmion_lattice" ? "bloch" : "neel",
    coreRadiusM: roundSig3(Math.max(1e-9, Math.min(0.08 * lMin, 15e-9))),
    radiusM: roundSig3(0.25 * lMin),
    innerRadiusM: roundSig3(0.16 * lMin),
    outerRadiusM: Math.max(roundSig3(0.34 * lMin), roundSig3(0.16 * lMin) * 1.5),
    wallWidthM:
      presetKind === "domain_wall"
        ? roundSig3(0.1 * longest.length)
        : presetKind === "skyrmionium"
          ? roundSig3(0.04 * lMin)
          : roundSig3(0.05 * lMin),
    wallHalfWidthM: roundSig3(0.25 * lMin),
    centerOffsetM: 0,
    leftDomain: presetKind === "two_domain" ? [1, 0, 0] : dwLeft,
    rightDomain: presetKind === "two_domain" ? [-1, 0, 0] : dwRight,
    lockAntiparallelRight: true,
    wallCenterMode: "auto",
    wallCenterDirection: [0, 1, 0],
    twoDomainSharp: true,
    leftMxSign: 1,
    rightMxSign: -1,
    helicityRad: 0,
    waveMode: "wavelength_axis",
    wavelengthM,
    propagationAxis: qHat,
    wavevectorPerM: [qHat[0] * qMag, qHat[1] * qMag, qHat[2] * qMag],
    e1,
    e2,
    coneAxis: qHat,
    coneAngleRad: Math.PI / 4,
    phaseRad: 0,
    axialScale: Math.max(0.2, Math.min(2.0, Number((lz / Math.max(l3dXy, 1e-12)).toPrecision(3)))),
    majorRadiusM: majorR,
    minorRadiusM: minorR,

    latticeSymmetry: "hexagonal",
    latticeConstantM: aLat,
    spiralKind: "cycloidal",
    spinPlaneNormal: longest.axis === "y" ? [0, 0, 1] : [0, 1, 0],
    bpKind: "circulating",
    bpPolarity: 1,
    bpTwistRad: Math.PI / 2,
    asiLattice: "square",
    asiVertexState: "type_i_ground",
    asiPitchM: roundSig3(0.25 * lMin),

    translationM: initialTranslation,
    translationUnitMode: defaultTranslationUnitForBounds(bounds),
    rotationMode: "euler_xyz",
    eulerDeg: [0, 0, 0],
    axisAngleAxis: [0, 0, 1],
    axisAngleDeg: 0,
    rotationQuat: [0, 0, 0, 1],
    rotateVectorsMode: "space_and_spins",
    scale: [1, 1, 1],
    uniformScaleLocked: true,
    pivotMode: hostContext === "region" ? "region_center" : "object_center",
    pivotM: [0, 0, 0],

    mappingSpace,
    clampMode: "none",
    tilePeriodM: [...bounds.size],
    backgroundVector: [0, 0, 1],
    axisExtentMode: "uniform",
    axisThicknessM: 1e-9,

    fieldOrigin: "file",
    fieldArtifactRef: "",
    fieldSourcePath: "",
    fieldSourceFormat: "auto",
    fieldDataset: "fields/m",
    fieldSampleIndex: -1,
    fieldInterpolation: "trilinear",
    fieldRenormalize: true,
    fieldZeroNormThreshold: 1e-6,
  };
}

/**
 * Fixes P0 MT-01: sets dimensionless `scale = [1, 1, 1]`, centers `translationM`
 * in target bounds, and updates metric physical parameters of the active preset
 * while keeping user-selected topological signs and orientation untouched.
 */
export function fitCharacteristicSizeToTarget(
  draft: MagneticTextureDraft,
  bounds: TargetMetricBounds,
): MagneticTextureDraft {
  const kind = canonicalPresetKind(draft.presetKind);
  const resolvedPlane =
    draft.planeMode === "auto" ? resolveLargestFacePlane(bounds.size) : draft.resolvedPlane;
  const [lu, lv] = planeInPlaneDimensions(bounds.size, resolvedPlane);
  const lMin = Math.min(lu, lv);
  const axisIdx = draft.normalAxis === "x" ? 0 : draft.normalAxis === "y" ? 1 : 2;
  const lAxis = bounds.size[axisIdx];
  const longest = resolveLongestAxis(bounds.size);
  const l3dXy = Math.min(bounds.size[0], bounds.size[1]);
  const lz = bounds.size[2];

  const centeredTranslation: Vec3 =
    draft.mappingSpace === "region"
      ? [0, 0, 0]
      : draft.mappingSpace === "world"
        ? [...bounds.worldCenter]
        : [...bounds.localCenter];

  const next: MagneticTextureDraft = {
    ...draft,
    resolvedPlane,
    scale: [1, 1, 1],
    translationM: centeredTranslation,
    tilePeriodM: [...bounds.size],
  };

  switch (kind) {
    case "vortex":
    case "antivortex":
      next.coreRadiusM = roundSig3(0.08 * lMin);
      break;
    case "bloch_skyrmion":
    case "neel_skyrmion":
    case "antiskyrmion":
    case "bimeron":
      next.radiusM = roundSig3(0.25 * lMin);
      next.wallWidthM = roundSig3(0.05 * lMin);
      break;
    case "skyrmionium": {
      const innerR = roundSig3(0.16 * lMin);
      next.innerRadiusM = innerR;
      next.outerRadiusM = Math.max(roundSig3(0.34 * lMin), innerR * 1.5);
      next.wallWidthM = roundSig3(0.04 * lMin);
      break;
    }
    case "skyrmion_lattice": {
      const rLat = roundSig3(0.1 * lMin);
      next.radiusM = rLat;
      next.latticeConstantM = Math.max(roundSig3(0.33 * lMin), 2.5 * rLat);
      next.wallWidthM = roundSig3(0.025 * lMin);
      break;
    }
    case "domain_wall":
      next.wallWidthM = roundSig3(0.1 * lAxis);
      next.centerOffsetM = 0;
      break;
    case "two_domain":
      next.wallWidthM = roundSig3(0.05 * lAxis);
      break;
    case "vortex_wall":
      next.wallHalfWidthM = roundSig3(0.25 * lMin);
      next.coreRadiusM = roundSig3(0.08 * lMin);
      break;
    case "artificial_spin_ice":
      next.asiPitchM = roundSig3(0.25 * lMin);
      break;
    case "helical":
    case "conical": {
      const qLen = Math.hypot(
        draft.propagationAxis[0],
        draft.propagationAxis[1],
        draft.propagationAxis[2],
      );
      const qHat: Vec3 =
        qLen > 1e-12
          ? [
              draft.propagationAxis[0] / qLen,
              draft.propagationAxis[1] / qLen,
              draft.propagationAxis[2] / qLen,
            ]
          : axisUnitVector(longest.axis);
      const projExtent =
        Math.abs(qHat[0]) * bounds.size[0] +
        Math.abs(qHat[1]) * bounds.size[1] +
        Math.abs(qHat[2]) * bounds.size[2];
      const wavelength = roundSig3(0.5 * (projExtent > 1e-12 ? projExtent : longest.length));
      const qMag = (2.0 * Math.PI) / wavelength;
      next.wavelengthM = wavelength;
      next.propagationAxis = qHat;
      next.wavevectorPerM = [qHat[0] * qMag, qHat[1] * qMag, qHat[2] * qMag];
      break;
    }
    case "spiral":
      next.wavelengthM = roundSig3(0.5 * longest.length);
      break;
    case "hopfion":
      next.radiusM = roundSig3(0.25 * l3dXy);
      next.axialScale = Math.max(
        0.2,
        Math.min(2.0, Number((lz / Math.max(l3dXy, 1e-12)).toPrecision(3))),
      );
      break;
    case "hopfion_compact_support": {
      const majorR = roundSig3(0.28 * l3dXy);
      next.majorRadiusM = majorR;
      next.minorRadiusM = Math.min(roundSig3(Math.min(0.12 * l3dXy, 0.45 * lz)), majorR);
      break;
    }
    case "bloch_point":
      next.coreRadiusM = roundSig3(Math.max(1e-9, 0.02 * Math.min(l3dXy, lz)));
      break;
    case "uniform":
    case "random":
      break;
  }

  return next;
}

export function centerDraftInTargetBounds(
  draft: MagneticTextureDraft,
  bounds: TargetMetricBounds,
): MagneticTextureDraft {
  const translationM: Vec3 =
    draft.mappingSpace === "region"
      ? [0, 0, 0]
      : draft.mappingSpace === "world"
        ? [...bounds.worldCenter]
        : [...bounds.localCenter];
  return { ...draft, translationM };
}

export function resetDraftTransform(
  draft: MagneticTextureDraft,
  bounds: TargetMetricBounds,
): MagneticTextureDraft {
  return {
    ...centerDraftInTargetBounds(draft, bounds),
    eulerDeg: [0, 0, 0],
    axisAngleAxis: [0, 0, 1],
    axisAngleDeg: 0,
    rotationQuat: [0, 0, 0, 1],
    rotateVectorsMode: "space_and_spins",
    scale: [1, 1, 1],
    pivotM: [0, 0, 0],
  };
}

export function switchDraftPresetPatch(
  current: MagneticTextureDraft,
  nextPresetKind: MagnetizationTexturePresetId,
  bounds: TargetMetricBounds,
): Partial<MagneticTextureDraft> {
  const fresh = createDefaultMagneticTextureDraft(
    nextPresetKind,
    bounds,
    current.mappingSpace === "region" ? "region" : "object",
  );
  const { resolvedPlane } = synchronizePlaneAndProjection(
    nextPresetKind,
    current.planeMode,
    current.resolvedPlane,
    "object_local",
    bounds,
  );
  return {
    presetKind: canonicalPresetKind(nextPresetKind),
    presetVersion: 2,
    sourceMode: "preset",
    resolvedPlane,
    normalAxis: fresh.normalAxis,
    corePolarity: fresh.corePolarity,
    wallKind: fresh.wallKind,
    coreRadiusM: fresh.coreRadiusM,
    radiusM: fresh.radiusM,
    innerRadiusM: fresh.innerRadiusM,
    outerRadiusM: fresh.outerRadiusM,
    wallWidthM: fresh.wallWidthM,
    wallHalfWidthM: fresh.wallHalfWidthM,
    centerOffsetM: fresh.centerOffsetM,
    leftDomain: fresh.leftDomain,
    rightDomain: fresh.rightDomain,
    lockAntiparallelRight: true,
    wallCenterMode: "auto",
    twoDomainSharp: true,
    wavelengthM: fresh.wavelengthM,
    propagationAxis: fresh.propagationAxis,
    wavevectorPerM: fresh.wavevectorPerM,
    e1: fresh.e1,
    e2: fresh.e2,
    coneAxis: fresh.coneAxis,
    coneAngleRad: fresh.coneAngleRad,
    axialScale: fresh.axialScale,
    majorRadiusM: fresh.majorRadiusM,
    minorRadiusM: fresh.minorRadiusM,
    latticeConstantM: fresh.latticeConstantM,
    asiPitchM: fresh.asiPitchM,
    scale: [1, 1, 1],
  };
}

export function orthonormalizeSecondBasis(
  e1Raw: readonly [number, number, number],
  e2Raw: readonly [number, number, number],
): Vec3 {
  const len1 = Math.hypot(e1Raw[0], e1Raw[1], e1Raw[2]);
  const u1: Vec3 = len1 > 1e-12 ? [e1Raw[0] / len1, e1Raw[1] / len1, e1Raw[2] / len1] : [1, 0, 0];
  const d = e2Raw[0] * u1[0] + e2Raw[1] * u1[1] + e2Raw[2] * u1[2];
  let proj: Vec3 = [e2Raw[0] - d * u1[0], e2Raw[1] - d * u1[1], e2Raw[2] - d * u1[2]];
  let projLen = Math.hypot(proj[0], proj[1], proj[2]);
  if (projLen <= 1e-12) {
    const helper: Vec3 = Math.abs(u1[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    proj = [
      u1[1] * helper[2] - u1[2] * helper[1],
      u1[2] * helper[0] - u1[0] * helper[2],
      u1[0] * helper[1] - u1[1] * helper[0],
    ];
    projLen = Math.hypot(proj[0], proj[1], proj[2]);
  }
  return [proj[0] / projLen, proj[1] / projLen, proj[2] / projLen];
}

export function validateScaleMultiplier(scale: readonly [number, number, number]): string | null {
  if (
    scale.length !== 3 ||
    scale.some((component) => typeof component !== "number" || !Number.isFinite(component))
  ) {
    return "Scale multiplier components must be finite numbers.";
  }
  if (scale.some((component) => Math.abs(component) <= 1e-14)) {
    return "Scale multiplier components must be nonzero.";
  }
  if (scale.some((component) => Math.abs(component) < 1e-3)) {
    return DIMENSIONLESS_SCALE_METRIC_ERROR;
  }
  return null;
}

function isNonZeroFiniteVec3(v: readonly [number, number, number]): boolean {
  return (
    v.length === 3 &&
    v.every((c) => typeof c === "number" && Number.isFinite(c)) &&
    Math.hypot(v[0], v[1], v[2]) > 1e-12
  );
}

export function validateMagneticTextureDraft(
  draft: MagneticTextureDraft,
): Map<string, string> {
  const errors = new Map<string, string>();
  if (draft.inheritanceMode === "inherit") {
    return errors;
  }

  if (draft.sourceMode === "field-file") {
    const ref =
      draft.fieldOrigin === "artifact"
        ? draft.fieldArtifactRef.trim()
        : draft.fieldSourcePath.trim();
    if (!ref) {
      errors.set(
        draft.fieldOrigin === "artifact" ? "fieldArtifactRef" : "fieldSourcePath",
        "Select a field-state artifact or project file path.",
      );
    }
    if (!Number.isInteger(draft.fieldSampleIndex) || draft.fieldSampleIndex < -1) {
      errors.set("fieldSampleIndex", "Frame index must be -1 (last frame) or a non-negative integer.");
    }
    return errors;
  }

  const scaleErr = validateScaleMultiplier(draft.scale);
  if (scaleErr) {
    errors.set("scale", scaleErr);
  }

  if (draft.clampMode !== "none") {
    if (draft.tilePeriodM.some((p) => !Number.isFinite(p) || p <= 1e-14)) {
      errors.set("tilePeriodM", "Tile / box size components must be finite and positive.");
    }
    if (draft.clampMode === "background" && !isNonZeroFiniteVec3(draft.backgroundVector)) {
      errors.set("backgroundVector", "Background spin vector cannot be the zero vector.");
    }
  }
  if (draft.axisExtentMode === "thickness") {
    if (!Number.isFinite(draft.axisThicknessM) || draft.axisThicknessM <= 0) {
      errors.set("axisThicknessM", "Axis thickness must be finite and positive.");
    }
  }

  const kind = canonicalPresetKind(draft.presetKind);
  switch (kind) {
    case "uniform":
      if (!isNonZeroFiniteVec3(draft.direction)) {
        errors.set("direction", "Direction cannot be the zero vector.");
      }
      break;
    case "random":
      if (!Number.isInteger(draft.seed) || draft.seed < 0 || draft.seed > Number.MAX_SAFE_INTEGER) {
        errors.set("seed", "Random seed must be a non-negative safe integer.");
      }
      break;
    case "vortex":
    case "antivortex":
      if (!Number.isFinite(draft.coreRadiusM) || draft.coreRadiusM <= 0) {
        errors.set("coreRadiusM", "Core radius must be positive.");
      }
      break;
    case "bloch_skyrmion":
    case "neel_skyrmion":
    case "antiskyrmion":
    case "bimeron":
      if (!Number.isFinite(draft.radiusM) || draft.radiusM <= 0) {
        errors.set("radiusM", "Characteristic radius must be positive.");
      }
      if (!Number.isFinite(draft.wallWidthM) || draft.wallWidthM <= 0) {
        errors.set("wallWidthM", "Wall width must be positive.");
      }
      break;
    case "skyrmionium":
      if (!Number.isFinite(draft.innerRadiusM) || draft.innerRadiusM <= 0) {
        errors.set("innerRadiusM", "Inner radius must be positive.");
      }
      if (!Number.isFinite(draft.outerRadiusM) || draft.outerRadiusM <= draft.innerRadiusM) {
        errors.set(
          "outerRadiusM",
          `Outer radius must exceed inner radius (${(draft.innerRadiusM * 1e9).toPrecision(3)} nm).`,
        );
      }
      if (!Number.isFinite(draft.wallWidthM) || draft.wallWidthM <= 0) {
        errors.set("wallWidthM", "Wall width must be positive.");
      }
      break;
    case "skyrmion_lattice":
      if (!Number.isFinite(draft.radiusM) || draft.radiusM <= 0) {
        errors.set("radiusM", "Skyrmion radius must be positive.");
      }
      if (!Number.isFinite(draft.latticeConstantM) || draft.latticeConstantM <= 2 * draft.radiusM) {
        errors.set(
          "latticeConstantM",
          `Lattice constant must exceed 2 × radius (${(2 * draft.radiusM * 1e9).toPrecision(3)} nm).`,
        );
      }
      if (!Number.isFinite(draft.wallWidthM) || draft.wallWidthM <= 0) {
        errors.set("wallWidthM", "Wall width must be positive.");
      }
      break;
    case "domain_wall": {
      if (!Number.isFinite(draft.wallWidthM) || draft.wallWidthM <= 0) {
        errors.set("wallWidthM", "Wall width must be positive.");
      }
      if (!isNonZeroFiniteVec3(draft.leftDomain)) {
        errors.set("leftDomain", "Left domain vector cannot be zero.");
      }
      if (!isNonZeroFiniteVec3(draft.rightDomain)) {
        errors.set("rightDomain", "Right domain vector cannot be zero.");
      } else if (isNonZeroFiniteVec3(draft.leftDomain)) {
        const lLen = Math.hypot(...draft.leftDomain);
        const rLen = Math.hypot(...draft.rightDomain);
        const cosAngle =
          (draft.leftDomain[0] * draft.rightDomain[0] +
            draft.leftDomain[1] * draft.rightDomain[1] +
            draft.leftDomain[2] * draft.rightDomain[2]) /
          (lLen * rLen);
        if (cosAngle > -1.0 + 1e-10) {
          errors.set(
            "rightDomain",
            "180° domain_wall requires Right = −Left. Use Two-domain for arbitrary domain angles.",
          );
        }
      }
      if (draft.wallCenterMode === "custom") {
        if (!isNonZeroFiniteVec3(draft.wallCenterDirection)) {
          errors.set("wallCenterDirection", "Wall center spin cannot be zero.");
        } else if (isNonZeroFiniteVec3(draft.leftDomain)) {
          const lLen = Math.hypot(...draft.leftDomain);
          const bLen = Math.hypot(...draft.wallCenterDirection);
          const cosBL =
            Math.abs(
              draft.leftDomain[0] * draft.wallCenterDirection[0] +
                draft.leftDomain[1] * draft.wallCenterDirection[1] +
                draft.leftDomain[2] * draft.wallCenterDirection[2],
            ) /
            (lLen * bLen);
          if (cosBL > 1e-10) {
            errors.set(
              "wallCenterDirection",
              "Wall center spin must be orthogonal to the left domain direction.",
            );
          }
        }
      }
      break;
    }
    case "two_domain":
      if (!isNonZeroFiniteVec3(draft.leftDomain)) {
        errors.set("leftDomain", "Left domain vector cannot be zero.");
      }
      if (!isNonZeroFiniteVec3(draft.rightDomain)) {
        errors.set("rightDomain", "Right domain vector cannot be zero.");
      }
      if (!isNonZeroFiniteVec3(draft.wallCenterDirection)) {
        errors.set("wallCenterDirection", "Boundary midpoint spin cannot be zero.");
      }
      if (!draft.twoDomainSharp && (!Number.isFinite(draft.wallWidthM) || draft.wallWidthM <= 0)) {
        errors.set("wallWidthM", "Wall width must be positive for a smooth tanh boundary.");
      }
      break;
    case "vortex_wall":
      if (!Number.isFinite(draft.wallHalfWidthM) || draft.wallHalfWidthM <= 0) {
        errors.set("wallHalfWidthM", "Wall half-width must be positive.");
      }
      if (!Number.isFinite(draft.coreRadiusM) || draft.coreRadiusM <= 0) {
        errors.set("coreRadiusM", "Core radius must be positive.");
      }
      break;
    case "artificial_spin_ice":
      if (!Number.isFinite(draft.asiPitchM) || draft.asiPitchM <= 0) {
        errors.set("asiPitchM", "Vertex pitch must be positive.");
      }
      break;
    case "helical": {
      if (draft.waveMode === "wavelength_axis") {
        if (!Number.isFinite(draft.wavelengthM) || draft.wavelengthM <= 0) {
          errors.set("wavelengthM", "Helical pitch λ must be positive.");
        }
        if (!isNonZeroFiniteVec3(draft.propagationAxis)) {
          errors.set("propagationAxis", "Propagation axis cannot be zero.");
        }
      } else if (!isNonZeroFiniteVec3(draft.wavevectorPerM)) {
        errors.set("wavevectorPerM", "Wavevector q cannot be zero.");
      }
      if (!isNonZeroFiniteVec3(draft.e1)) {
        errors.set("e1", "Spin basis e₁ cannot be zero.");
      }
      if (!isNonZeroFiniteVec3(draft.e2)) {
        errors.set("e2", "Spin basis e₂ cannot be zero.");
      } else if (isNonZeroFiniteVec3(draft.e1)) {
        const l1 = Math.hypot(...draft.e1);
        const l2 = Math.hypot(...draft.e2);
        const cos12 =
          Math.abs(
            draft.e1[0] * draft.e2[0] + draft.e1[1] * draft.e2[1] + draft.e1[2] * draft.e2[2],
          ) /
          (l1 * l2);
        if (cos12 > 1e-10) {
          errors.set("e2", "Spin basis vectors e₁ and e₂ must be orthogonal.");
        }
      }
      break;
    }
    case "conical":
      if (draft.waveMode === "wavelength_axis") {
        if (!Number.isFinite(draft.wavelengthM) || draft.wavelengthM <= 0) {
          errors.set("wavelengthM", "Conical pitch λ must be positive.");
        }
        if (!isNonZeroFiniteVec3(draft.propagationAxis)) {
          errors.set("propagationAxis", "Propagation axis cannot be zero.");
        }
      } else if (!isNonZeroFiniteVec3(draft.wavevectorPerM)) {
        errors.set("wavevectorPerM", "Wavevector q cannot be zero.");
      }
      if (!isNonZeroFiniteVec3(draft.coneAxis)) {
        errors.set("coneAxis", "Cone axis cannot be zero.");
      }
      if (
        !Number.isFinite(draft.coneAngleRad) ||
        draft.coneAngleRad < 0 ||
        draft.coneAngleRad > Math.PI + 1e-12
      ) {
        errors.set("coneAngleRad", "Cone half-angle β must lie between 0° and 180°.");
      }
      break;
    case "spiral":
      if (!Number.isFinite(draft.wavelengthM) || draft.wavelengthM <= 0) {
        errors.set("wavelengthM", "Spiral wavelength λ must be positive.");
      }
      if (!isNonZeroFiniteVec3(draft.propagationAxis)) {
        errors.set("propagationAxis", "Propagation axis cannot be zero.");
      }
      if (draft.spiralKind !== "proper_screw" && !isNonZeroFiniteVec3(draft.spinPlaneNormal)) {
        errors.set("spinPlaneNormal", "Spin-plane normal cannot be zero.");
      } else if (
        draft.spiralKind === "cycloidal" &&
        isNonZeroFiniteVec3(draft.propagationAxis) &&
        isNonZeroFiniteVec3(draft.spinPlaneNormal)
      ) {
        const lq = Math.hypot(...draft.propagationAxis);
        const ln = Math.hypot(...draft.spinPlaneNormal);
        const cosQN =
          Math.abs(
            draft.propagationAxis[0] * draft.spinPlaneNormal[0] +
              draft.propagationAxis[1] * draft.spinPlaneNormal[1] +
              draft.propagationAxis[2] * draft.spinPlaneNormal[2],
          ) /
          (lq * ln);
        if (cosQN > 1 - 1e-6) {
          errors.set(
            "spinPlaneNormal",
            "Spin-plane normal must not be parallel to propagation axis for a cycloidal spiral.",
          );
        }
      }
      break;
    case "hopfion":
      if (!Number.isFinite(draft.radiusM) || draft.radiusM <= 0) {
        errors.set("radiusM", "Characteristic radius must be positive.");
      }
      if (!Number.isFinite(draft.axialScale) || draft.axialScale <= 0) {
        errors.set("axialScale", "Axial scale γ_z must be positive.");
      }
      break;
    case "hopfion_compact_support":
      if (!Number.isFinite(draft.majorRadiusM) || draft.majorRadiusM <= 0) {
        errors.set("majorRadiusM", "Major radius must be positive.");
      }
      if (!Number.isFinite(draft.minorRadiusM) || draft.minorRadiusM <= 0) {
        errors.set("minorRadiusM", "Minor tube radius must be positive.");
      } else if (draft.minorRadiusM > draft.majorRadiusM) {
        errors.set(
          "minorRadiusM",
          `Minor radius must be ≤ major radius (${(draft.majorRadiusM * 1e9).toPrecision(3)} nm).`,
        );
      }
      break;
    case "bloch_point":
      if (!Number.isFinite(draft.coreRadiusM) || draft.coreRadiusM <= 0) {
        errors.set("coreRadiusM", "Core regularization radius must be positive.");
      }
      if (
        !Number.isFinite(draft.bpTwistRad) ||
        draft.bpTwistRad < -Math.PI - 1e-12 ||
        draft.bpTwistRad > Math.PI + 1e-12
      ) {
        errors.set("bpTwistRad", "Equatorial twist angle must lie in [−180°, +180°].");
      }
      break;
  }

  return errors;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function readNum(rec: Record<string, unknown> | null, key: string, fallback: number): number {
  const v = rec?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readSign(rec: Record<string, unknown> | null, key: string, fallback: -1 | 1): -1 | 1 {
  const v = rec?.[key];
  return v === -1 ? -1 : v === 1 ? 1 : fallback;
}

function readVec3(rec: Record<string, unknown> | null, key: string, fallback: Vec3): Vec3 {
  const v = rec?.[key];
  if (
    Array.isArray(v) &&
    v.length >= 3 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    typeof v[2] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  ) {
    return [v[0], v[1], v[2]];
  }
  return fallback;
}

function normalizeOrFallback(v: Vec3, fallback: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len <= 1e-12) return fallback;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function hydrateMagneticTextureDraftFromInitializer(
  rawInitializer: unknown,
  bounds: TargetMetricBounds,
  hostContext: "object" | "region" | "stage" = "object",
  options?: { inherited?: boolean },
): MagneticTextureDraft {
  const rec = asRecord(rawInitializer);
  if (!rec) {
    const emptyDraft = createDefaultMagneticTextureDraft("uniform", bounds, hostContext);
    return {
      ...emptyDraft,
      inheritanceMode: hostContext === "region" ? "inherit" : "override",
    };
  }

  const rawKind = typeof rec.kind === "string" ? rec.kind : "preset_texture";
  if (rawKind === "sampled" || rawKind === "file" || rawKind === "sampled_field") {
    const base = createDefaultMagneticTextureDraft("uniform", bounds, hostContext);
    const artifactRef = typeof rec.artifact_ref === "string" ? rec.artifact_ref : "";
    const sourcePath = typeof rec.source_path === "string" ? rec.source_path : "";
    return {
      ...base,
      inheritanceMode: options?.inherited ? "inherit" : "override",
      sourceMode: "field-file",
      customUiLabel: typeof rec.ui_label === "string" ? rec.ui_label : "",
      fieldOrigin: artifactRef && !sourcePath ? "artifact" : "file",
      fieldArtifactRef: artifactRef,
      fieldSourcePath: sourcePath,
      fieldSourceFormat:
        rec.source_format === "field_state_json" ||
        rec.source_format === "zarr" ||
        rec.source_format === "h5" ||
        rec.source_format === "ovf" ||
        rec.source_format === "npz"
          ? rec.source_format
          : "auto",
      fieldDataset: typeof rec.dataset === "string" && rec.dataset ? rec.dataset : "fields/m",
      fieldSampleIndex:
        typeof rec.sample_index === "number" && Number.isInteger(rec.sample_index)
          ? rec.sample_index
          : -1,
      fieldInterpolation:
        rec.interpolation === "exact" ||
        rec.interpolation === "nearest" ||
        rec.interpolation === "trilinear"
          ? rec.interpolation
          : "trilinear",
      fieldRenormalize: rec.renormalize !== false,
    };
  }

  // Handle shorthand initializers { kind: "uniform", value: [...] } or { kind: "random_seeded", seed: N }
  let rawPresetKind: MagnetizationTexturePresetId = "uniform";
  if (isMagnetizationTexturePresetId(rec.preset_kind)) {
    rawPresetKind = rec.preset_kind;
  } else if (isMagnetizationTexturePresetId(rawKind)) {
    rawPresetKind = rawKind;
  }

  const base = createDefaultMagneticTextureDraft(rawPresetKind, bounds, hostContext);
  const params =
    asRecord(rec.preset_params) ??
    (rawKind === "uniform" && Array.isArray(rec.value)
      ? { direction: rec.value }
      : rawKind === "random_seeded" && typeof rec.seed === "number"
        ? { seed: rec.seed }
        : {});
  const mapping = asRecord(rec.mapping);
  const transform = asRecord(rec.texture_transform);

  const explicitPlane =
    params?.plane === "xy" || params?.plane === "xz" || params?.plane === "yz"
      ? params.plane
      : mapping?.projection === "planar_xy"
        ? "xy"
        : mapping?.projection === "planar_xz"
          ? "xz"
          : mapping?.projection === "planar_yz"
            ? "yz"
            : null;
  const planeMode: PlaneSelectionMode = explicitPlane ?? "auto";
  const resolvedPlane = explicitPlane ?? resolveLargestFacePlane(bounds.size);

  const normalAxis: "x" | "y" | "z" =
    params?.normal_axis === "x" || params?.normal_axis === "y" || params?.normal_axis === "z"
      ? params.normal_axis
      : base.normalAxis;

  const leftDomain = readVec3(params, "left", base.leftDomain);
  const rightDomain = readVec3(params, "right", [-leftDomain[0], -leftDomain[1], -leftDomain[2]]);
  const lNorm = normalizeOrFallback(leftDomain, [1, 0, 0]);
  const rNorm = normalizeOrFallback(rightDomain, [-1, 0, 0]);
  const isAntiparallel =
    lNorm[0] * rNorm[0] + lNorm[1] * rNorm[1] + lNorm[2] * rNorm[2] <= -1 + 1e-6;

  const wallKind: "neel" | "bloch" =
    params?.kind === "bloch" ? "bloch" : params?.kind === "neel" ? "neel" : base.wallKind;
  const autoWallCenter = fallbackDomainWallDirection(axisUnitVector(normalAxis), lNorm, wallKind);
  let wallCenterMode: WallCenterDirectionMode = "auto";
  let wallCenterDirection: Vec3 = autoWallCenter;
  if (rawPresetKind === "two_domain") {
    wallCenterDirection = readVec3(params, "wall", [0, 1, 0]);
  } else if (params?.wall_center_direction !== undefined) {
    const custom = readVec3(params, "wall_center_direction", autoWallCenter);
    const customNorm = normalizeOrFallback(custom, autoWallCenter);
    const diff = Math.max(
      Math.abs(customNorm[0] - autoWallCenter[0]),
      Math.abs(customNorm[1] - autoWallCenter[1]),
      Math.abs(customNorm[2] - autoWallCenter[2]),
    );
    wallCenterDirection = custom;
    wallCenterMode = diff > 1e-6 ? "custom" : "custom";
  }

  // Two-domain sharp vs smooth tanh preservation (MT-03)
  const twoDomainSharp =
    params?.sharp === false
      ? false
      : params?.sharp === true
        ? true
        : params?.wall_width !== undefined && rawPresetKind === "two_domain"
          ? false
          : true;

  // Wavevector <-> wavelength + propagation axis (MT-05)
  const rawWavevec = readVec3(params, "wavevector", base.wavevectorPerM);
  const qNorm = Math.hypot(rawWavevec[0], rawWavevec[1], rawWavevec[2]);
  const wavelengthM =
    rawPresetKind === "spiral"
      ? readNum(params, "wavelength", base.wavelengthM)
      : qNorm > 1e-14
        ? (2.0 * Math.PI) / qNorm
        : base.wavelengthM;
  const propagationAxis: Vec3 =
    rawPresetKind === "spiral"
      ? readVec3(params, "propagation_axis", base.propagationAxis)
      : qNorm > 1e-14
        ? [rawWavevec[0] / qNorm, rawWavevec[1] / qNorm, rawWavevec[2] / qNorm]
        : base.propagationAxis;

  // Rotation quaternion & Euler XYZ
  let rotationQuat: Quat4 = [0, 0, 0, 1];
  const rawQuat = transform?.rotation_quat;
  if (
    Array.isArray(rawQuat) &&
    rawQuat.length >= 4 &&
    rawQuat.slice(0, 4).every((c) => typeof c === "number" && Number.isFinite(c))
  ) {
    try {
      rotationQuat = normalizeQuaternion([
        rawQuat[0] as number,
        rawQuat[1] as number,
        rawQuat[2] as number,
        rawQuat[3] as number,
      ]);
    } catch {
      rotationQuat = [0, 0, 0, 1];
    }
  } else if (Array.isArray(transform?.rotation_deg)) {
    const eDeg = readVec3(transform, "rotation_deg", [0, 0, 0]);
    rotationQuat = eulerDegreesToQuaternion(eDeg);
  }
  const eulerDeg = quaternionToEulerDegrees(rotationQuat);
  const { axis: axisAngleAxis, angleDeg: axisAngleDeg } = quaternionToAxisAngle(rotationQuat);

  const scale = readVec3(transform, "scale", [1, 1, 1]);
  const uniformScaleLocked =
    Math.abs(scale[0] - scale[1]) < 1e-9 && Math.abs(scale[1] - scale[2]) < 1e-9;

  const pivotM = readVec3(transform, "pivot", [0, 0, 0]);
  const isZeroPivot = Math.hypot(pivotM[0], pivotM[1], pivotM[2]) < 1e-15;
  const pivotMode: PivotPresetMode = isZeroPivot
    ? hostContext === "region"
      ? "region_center"
      : "object_center"
    : "custom";

  const mappingSpace: TextureMappingSpaceMode =
    mapping?.space === "region"
      ? "region"
      : mapping?.space === "world"
        ? "world"
        : "object";

  const rawClamp = String(mapping?.clamp_mode ?? mapping?.clamp ?? "none");
  const clampMode: TextureClampModeV2 =
    rawClamp === "clamp" ||
    rawClamp === "repeat" ||
    rawClamp === "mirror" ||
    rawClamp === "background"
      ? rawClamp
      : "none";

  const rawAxisExtent = String(mapping?.axis_extent_mode ?? "uniform")
    .trim()
    .toLowerCase();
  const axisExtentMode: TextureAxisExtentModeV2 =
    rawAxisExtent === "thickness" ? "thickness" : "uniform";
  const rawAxisThickness = readNum(mapping, "axis_thickness_m", base.axisThicknessM);
  const axisThicknessM =
    Number.isFinite(rawAxisThickness) && rawAxisThickness > 0
      ? rawAxisThickness
      : base.axisThicknessM;

  const leftMxNum = readNum(params, "left_mx", 1);
  const rightMxNum = readNum(params, "right_mx", -1);
  const leftMxSign: -1 | 1 = leftMxNum < 0 ? -1 : 1;
  const rightMxSign: -1 | 1 = rightMxNum < 0 ? -1 : 1;
  const defaultAutoCirc: -1 | 1 = leftMxSign * rightMxSign > 0 ? 1 : -1;
  const explicitCirc = readSign(params, "circulation", defaultAutoCirc);

  // Preserve custom ui_label ONLY if it is non-empty and not an auto-generated placeholder
  const rawUiLabel = typeof rec.ui_label === "string" ? rec.ui_label.trim() : "";
  const autoName = humanPresetLabel(rawPresetKind);
  const isLegacyGeneratedLabel =
    rawUiLabel === `${rawPresetKind} texture` ||
    rawUiLabel === "Uniform texture" ||
    rawUiLabel === autoName;

  return {
    ...base,
    inheritanceMode: options?.inherited ? "inherit" : "override",
    sourceMode: "preset",
    customUiLabel: isLegacyGeneratedLabel ? "" : rawUiLabel,
    presetVersion: rec.preset_version === 1 ? 1 : 2,
    presetKind: canonicalPresetKind(rawPresetKind),

    planeMode,
    resolvedPlane,
    normalAxis,

    direction: readVec3(params, "direction", [1, 0, 0]),
    seed: Math.max(0, Math.trunc(readNum(params, "seed", 1))),
    circulation: explicitCirc,
    circulationAuto: params?.circulation === undefined,
    corePolarity: readSign(params, "core_polarity", base.corePolarity),
    chirality: readSign(params, "chirality", 1),
    vorticity: readSign(params, "vorticity", 1),
    backgroundSign: readSign(params, "background_sign", 1),
    hopfCharge: readSign(params, "hopf_charge", 1),
    wallKind,
    coreRadiusM: readNum(params, "core_radius", base.coreRadiusM),
    radiusM: readNum(params, "radius", base.radiusM),
    innerRadiusM: readNum(params, "inner_radius", base.innerRadiusM),
    outerRadiusM: readNum(params, "outer_radius", base.outerRadiusM),
    wallWidthM:
      rawPresetKind === "domain_wall"
        ? readNum(params, "width", base.wallWidthM)
        : readNum(params, "wall_width", base.wallWidthM),
    wallHalfWidthM: readNum(params, "wall_half_width", base.wallHalfWidthM),
    centerOffsetM: readNum(params, "center_offset", 0),
    leftDomain,
    rightDomain,
    lockAntiparallelRight: isAntiparallel,
    wallCenterMode,
    wallCenterDirection,
    twoDomainSharp,
    leftMxSign,
    rightMxSign,
    helicityRad: readNum(params, "helicity_rad", 0),
    waveMode: "wavelength_axis",
    wavelengthM,
    propagationAxis,
    wavevectorPerM: rawWavevec,
    e1: readVec3(params, "e1", base.e1),
    e2: readVec3(params, "e2", base.e2),
    coneAxis: readVec3(params, "cone_axis", base.coneAxis),
    coneAngleRad: readNum(params, "cone_angle_rad", Math.PI / 4),
    phaseRad: readNum(params, "phase_rad", 0),
    axialScale: readNum(params, "axial_scale", base.axialScale),
    majorRadiusM: readNum(params, "major_radius", base.majorRadiusM),
    minorRadiusM: readNum(params, "minor_radius", base.minorRadiusM),

    latticeSymmetry: params?.lattice === "square" ? "square" : "hexagonal",
    latticeConstantM: readNum(params, "lattice_constant", base.latticeConstantM),
    spiralKind:
      params?.spiral_kind === "proper_screw" || params?.spiral_kind === "custom_plane"
        ? params.spiral_kind
        : "cycloidal",
    spinPlaneNormal: readVec3(params, "spin_plane_normal", base.spinPlaneNormal),
    bpKind:
      params?.bp_kind === "radial" || params?.bp_kind === "hyperbolic"
        ? params.bp_kind
        : "circulating",
    bpPolarity: readSign(params, "polarity", 1),
    bpTwistRad: readNum(
      params,
      "twist_rad",
      params?.bp_kind === "radial" || params?.bp_kind === "hyperbolic" ? 0 : Math.PI / 2,
    ),
    asiLattice: params?.lattice === "kagome" ? "kagome" : "square",
    asiVertexState:
      params?.vertex_state === "type_ii_polarized" || params?.vertex_state === "monopole_pair"
        ? params.vertex_state
        : "type_i_ground",
    asiPitchM: readNum(params, "pitch", base.asiPitchM),

    translationM: readVec3(transform, "translation", base.translationM),
    rotationMode: "euler_xyz",
    eulerDeg,
    axisAngleAxis,
    axisAngleDeg,
    rotationQuat,
    rotateVectorsMode: transform?.rotate_vectors === false ? "space_only" : "space_and_spins",
    scale,
    uniformScaleLocked,
    pivotMode,
    pivotM,

    mappingSpace,
    clampMode,
    tilePeriodM: readVec3(mapping, "tile_period", [...bounds.size]),
    backgroundVector: readVec3(mapping, "background_vector", [0, 0, 1]),
    axisExtentMode,
    axisThicknessM,
  };
}

export function buildPresetSpecFromDraft(
  draft: MagneticTextureDraft,
  bounds: TargetMetricBounds,
): PresetTextureSpecV2 {
  const kind = canonicalPresetKind(draft.presetKind);
  const { resolvedPlane, mappingProjection } = synchronizePlaneAndProjection(
    kind,
    draft.planeMode,
    draft.resolvedPlane,
    "object_local",
    bounds,
  );

  const qVec: Vec3 =
    draft.waveMode === "wavelength_axis"
      ? (() => {
          const qHat = normalizeOrFallback(draft.propagationAxis, [1, 0, 0]);
          const qMag = (2.0 * Math.PI) / Math.max(draft.wavelengthM, 1e-15);
          return [qHat[0] * qMag, qHat[1] * qMag, qHat[2] * qMag];
        })()
      : draft.wavevectorPerM;

  let presetParams: Record<string, unknown>;
  switch (kind) {
    case "uniform":
      presetParams = { direction: normalizeOrFallback(draft.direction, [1, 0, 0]) };
      break;
    case "random":
      presetParams = { seed: Math.max(0, Math.trunc(draft.seed)) };
      break;
    case "vortex":
    case "antivortex":
      presetParams = {
        plane: resolvedPlane,
        circulation: draft.circulation,
        core_polarity: draft.corePolarity,
        core_radius: draft.coreRadiusM,
      };
      break;
    case "bloch_skyrmion":
    case "neel_skyrmion":
    case "antiskyrmion":
      presetParams = {
        plane: resolvedPlane,
        radius: draft.radiusM,
        wall_width: draft.wallWidthM,
        core_polarity: draft.corePolarity,
        chirality: draft.chirality,
      };
      break;
    case "skyrmionium":
      presetParams = {
        plane: resolvedPlane,
        inner_radius: draft.innerRadiusM,
        outer_radius: draft.outerRadiusM,
        wall_width: draft.wallWidthM,
        kind: draft.wallKind,
        chirality: draft.chirality,
        background_sign: draft.backgroundSign,
      };
      break;
    case "bimeron":
      presetParams = {
        plane: resolvedPlane,
        radius: draft.radiusM,
        wall_width: draft.wallWidthM,
        vorticity: draft.vorticity,
        helicity_rad: draft.helicityRad,
        background_sign: draft.backgroundSign,
      };
      break;
    case "skyrmion_lattice":
      presetParams = {
        plane: resolvedPlane,
        lattice: draft.latticeSymmetry,
        lattice_constant: draft.latticeConstantM,
        radius: draft.radiusM,
        wall_width: draft.wallWidthM,
        kind: draft.wallKind,
        core_polarity: draft.corePolarity,
        chirality: draft.chirality,
      };
      break;
    case "domain_wall": {
      const leftNorm = normalizeOrFallback(draft.leftDomain, [0, 1, 0]);
      const rightNorm = draft.lockAntiparallelRight
        ? ([-leftNorm[0], -leftNorm[1], -leftNorm[2]] as Vec3)
        : normalizeOrFallback(draft.rightDomain, [-leftNorm[0], -leftNorm[1], -leftNorm[2]]);
      presetParams = {
        normal_axis: draft.normalAxis,
        kind: draft.wallKind,
        width: draft.wallWidthM,
        center_offset: draft.centerOffsetM,
        left: leftNorm,
        right: rightNorm,
        ...(draft.wallCenterMode === "custom"
          ? {
              wall_center_direction: normalizeOrFallback(
                draft.wallCenterDirection,
                fallbackDomainWallDirection(
                  axisUnitVector(draft.normalAxis),
                  leftNorm,
                  draft.wallKind,
                ),
              ),
            }
          : {}),
      };
      break;
    }
    case "two_domain":
      presetParams = {
        normal_axis: draft.normalAxis,
        left: normalizeOrFallback(draft.leftDomain, [1, 0, 0]),
        right: normalizeOrFallback(draft.rightDomain, [-1, 0, 0]),
        wall: normalizeOrFallback(draft.wallCenterDirection, [0, 1, 0]),
        sharp: draft.twoDomainSharp,
        ...(draft.twoDomainSharp ? {} : { wall_width: draft.wallWidthM }),
      };
      break;
    case "vortex_wall": {
      const autoCirc: -1 | 1 = draft.leftMxSign * draft.rightMxSign > 0 ? 1 : -1;
      presetParams = {
        plane: resolvedPlane,
        wall_half_width: draft.wallHalfWidthM,
        left_mx: draft.leftMxSign,
        right_mx: draft.rightMxSign,
        circulation: draft.circulationAuto ? autoCirc : draft.circulation,
        core_polarity: draft.corePolarity,
        core_radius: draft.coreRadiusM,
      };
      break;
    }
    case "artificial_spin_ice":
      presetParams = {
        plane: resolvedPlane,
        lattice: draft.asiLattice,
        vertex_state: draft.asiVertexState,
        pitch: draft.asiPitchM,
      };
      break;
    case "helical":
      presetParams = {
        wavevector: qVec,
        e1: normalizeOrFallback(draft.e1, [0, 1, 0]),
        e2: normalizeOrFallback(draft.e2, [0, 0, 1]),
        phase_rad: draft.phaseRad,
      };
      break;
    case "conical":
      presetParams = {
        wavevector: qVec,
        cone_axis: normalizeOrFallback(draft.coneAxis, [1, 0, 0]),
        cone_angle_rad: draft.coneAngleRad,
        phase_rad: draft.phaseRad,
      };
      break;
    case "spiral":
      presetParams = {
        spiral_kind: draft.spiralKind,
        wavelength: draft.wavelengthM,
        propagation_axis: normalizeOrFallback(draft.propagationAxis, [1, 0, 0]),
        ...(draft.spiralKind === "proper_screw"
          ? {}
          : { spin_plane_normal: normalizeOrFallback(draft.spinPlaneNormal, [0, 1, 0]) }),
        chirality: draft.chirality,
        phase_rad: draft.phaseRad,
      };
      break;
    case "hopfion":
      presetParams = {
        radius: draft.radiusM,
        hopf_charge: draft.hopfCharge,
        background_sign: draft.backgroundSign,
        axial_scale: draft.axialScale,
        phase_rad: draft.phaseRad,
      };
      break;
    case "hopfion_compact_support":
      presetParams = {
        major_radius: draft.majorRadiusM,
        minor_radius: draft.minorRadiusM,
      };
      break;
    case "bloch_point":
      presetParams = {
        bp_kind: draft.bpKind,
        polarity: draft.bpPolarity,
        twist_rad: draft.bpTwistRad,
        core_radius: draft.coreRadiusM,
      };
      break;
  }

  const rotationQuat =
    draft.rotationMode === "axis_angle"
      ? axisAngleToQuaternion(draft.axisAngleAxis, draft.axisAngleDeg)
      : eulerDegreesToQuaternion(draft.eulerDeg);

  return {
    preset_kind: kind,
    preset_version: 2,
    preset_params: presetParams,
    mapping: {
      space: draft.mappingSpace,
      projection: mappingProjection,
      clamp_mode: draft.clampMode,
      ...(draft.clampMode !== "none" ? { tile_period: draft.tilePeriodM } : {}),
      ...(draft.clampMode === "background"
        ? { background_vector: normalizeOrFallback(draft.backgroundVector, [0, 0, 1]) }
        : {}),
      ...(draft.axisExtentMode === "thickness"
        ? {
            axis_extent_mode: "thickness",
            axis_thickness_m: draft.axisThicknessM,
          }
        : {}),
    },
    texture_transform: {
      translation: draft.translationM,
      rotation_quat: rotationQuat,
      scale: draft.scale,
      pivot: draft.pivotM,
      rotate_vectors: draft.rotateVectorsMode !== "space_only",
    },
  };
}

export function serializeMagneticTextureDraftToInitializer(
  draft: MagneticTextureDraft,
  bounds: TargetMetricBounds,
): JsonObject {
  if (draft.sourceMode === "field-file") {
    const customLabel = draft.customUiLabel.trim();
    return {
      kind: "sampled",
      ...(draft.fieldOrigin === "artifact"
        ? { artifact_ref: draft.fieldArtifactRef.trim() }
        : { source_path: draft.fieldSourcePath.trim() }),
      ...(draft.fieldSourceFormat !== "auto" ? { source_format: draft.fieldSourceFormat } : {}),
      dataset: draft.fieldDataset.trim() || "fields/m",
      sample_index: draft.fieldSampleIndex,
      interpolation: draft.fieldInterpolation,
      renormalize: draft.fieldRenormalize,
      ui_label: customLabel || null,
    } as JsonObject;
  }

  const spec = buildPresetSpecFromDraft(draft, bounds);
  return {
    kind: "preset_texture",
    preset_kind: spec.preset_kind,
    preset_version: 2,
    preset_params: spec.preset_params as JsonObject,
    mapping: spec.mapping as unknown as JsonObject,
    texture_transform: spec.texture_transform as unknown as JsonObject,
  };
}

function pyTuple(v: readonly number[]): string {
  return `(${v.map((n) => (Object.is(n, -0) ? "0.0" : Number(n.toPrecision(12)).toString())).join(", ")})`;
}

export function formatMagneticTexturePythonExpression(
  draft: MagneticTextureDraft,
  bounds: TargetMetricBounds,
  targetExpression = "target.m",
): string {
  if (draft.inheritanceMode === "inherit") {
    return `${targetExpression} = None  # Inherited from parent object`;
  }
  if (draft.sourceMode === "field-file") {
    const pathOrRef =
      draft.fieldOrigin === "artifact" ? draft.fieldArtifactRef : draft.fieldSourcePath;
    return `${targetExpression} = fm.init.load_magnetization(${JSON.stringify(pathOrRef || "field_state.ovf")}, dataset=${JSON.stringify(draft.fieldDataset)}, sample=${draft.fieldSampleIndex})`;
  }

  const spec = buildPresetSpecFromDraft(draft, bounds);
  const params = spec.preset_params ?? {};
  const args = Object.entries(params)
    .filter(([k, val]) => !(k === "plane" && val === "xy"))
    .map(([k, val]) => {
      if (Array.isArray(val)) return `${k}=${pyTuple(val as number[])}`;
      if (typeof val === "boolean") return `${k}=${val ? "True" : "False"}`;
      if (typeof val === "string") return `${k}=${JSON.stringify(val)}`;
      return `${k}=${String(val)}`;
    })
    .join(", ");

  const chain: string[] = [`fm.texture.${spec.preset_kind}(${args})`];
  const [tx, ty, tz] = draft.translationM;
  if (Math.hypot(tx, ty, tz) > 1e-15) {
    chain.push(`.translate(${tx}, ${ty}, ${tz})`);
  }
  const [rx, ry, rz] = draft.eulerDeg;
  if (Math.abs(rx) > 1e-9) chain.push(`.rotate_x_deg(${rx})`);
  if (Math.abs(ry) > 1e-9) chain.push(`.rotate_y_deg(${ry})`);
  if (Math.abs(rz) > 1e-9) chain.push(`.rotate_z_deg(${rz})`);
  if (draft.rotateVectorsMode === "space_only") {
    chain.push(`.with_rotate_vectors(False)`);
  }
  const [sx, sy, sz] = draft.scale;
  if (Math.abs(sx - 1) > 1e-9 || Math.abs(sy - 1) > 1e-9 || Math.abs(sz - 1) > 1e-9) {
    chain.push(`.scale(${sx}, ${sy}, ${sz})`);
  }
  const [px, py, pz] = draft.pivotM;
  if (Math.hypot(px, py, pz) > 1e-15) {
    chain.push(`.with_pivot(${pyTuple([px, py, pz])})`);
  }
  if (
    draft.mappingSpace !== "object" ||
    draft.clampMode !== "none" ||
    draft.axisExtentMode === "thickness"
  ) {
    const mapArgs: string[] = [];
    if (draft.mappingSpace !== "object" || draft.clampMode !== "none") {
      mapArgs.push(`space=${JSON.stringify(draft.mappingSpace)}`);
      mapArgs.push(`clamp_mode=${JSON.stringify(draft.clampMode)}`);
    }
    if (draft.clampMode !== "none") {
      mapArgs.push(`tile_period=${pyTuple(draft.tilePeriodM)}`);
    }
    if (draft.clampMode === "background") {
      mapArgs.push(`background_vector=${pyTuple(draft.backgroundVector)}`);
    }
    if (draft.axisExtentMode === "thickness") {
      mapArgs.push(`axis_extent_mode="thickness"`);
      mapArgs.push(`axis_thickness_m=${draft.axisThicknessM}`);
    }
    chain.push(`.with_mapping(${mapArgs.join(", ")})`);
  }

  return chain.length === 1
    ? `${targetExpression} = ${chain[0]}`
    : `${targetExpression} = (\n    ${chain.join("\n    ")}\n)`;
}
