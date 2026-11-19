import {
  floquetPhaseAdapter,
  phasorAdapter,
  type FloquetSpatialConvention,
  type PhasorConvention,
} from "@/shared/domain/analysis/phasorConventionAdapter";
import {
  DIRECTION_HSL_NEUTRAL_RGB,
  directionHslSrgb,
} from "@/shared/visualization/directionColor";
import {
  getScalarColorPaletteStops,
  isDivergingScalarPalette,
  normalizeScalarColorPalette,
  scalarColorRgb,
  scalarColorSrgb,
} from "@/shared/visualization/scalarColorPalette";

import type {
  Export3DColorMode,
  Export3DComplexFieldInput,
  Export3DComplexRepresentation,
  Export3DIndexArray,
  Export3DNumericArray,
  Export3DRgbTuple,
  Export3DScalarPalette,
  Export3DScalarRange,
} from "./export3dTypes";

const DEFAULT_MONOCHROME_SRGB: Export3DRgbTuple = [0.75, 0.78, 0.85];
const MISSING_COVERAGE_SRGB: Export3DRgbTuple = [0.5, 0.5, 0.5];
const TWO_PI = Math.PI * 2;

const COLOR_MODES = new Set<Export3DColorMode>([
  "orientation",
  "magnitude",
  "x",
  "y",
  "z",
  "scalar",
  "monochrome",
]);

/** Converts one display sRGB channel in [0, 1] to linear-sRGB. */
export function srgbToLinearChannel(channel: number): number {
  if (!Number.isFinite(channel)) return 0;
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.04045
    ? clamped / 12.92
    : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/** Converts one linear-sRGB channel in [0, 1] to display sRGB. */
export function linearToSrgbChannel(channel: number): number {
  if (!Number.isFinite(channel)) return 0;
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

export function srgbToLinearRgb(rgb: Export3DRgbTuple): [number, number, number] {
  return [
    srgbToLinearChannel(rgb[0]),
    srgbToLinearChannel(rgb[1]),
    srgbToLinearChannel(rgb[2]),
  ];
}

export function linearToSrgbRgb(rgb: Export3DRgbTuple): [number, number, number] {
  return [
    linearToSrgbChannel(rgb[0]),
    linearToSrgbChannel(rgb[1]),
    linearToSrgbChannel(rgb[2]),
  ];
}

export function normalizeExport3DColorMode(
  value: string | null | undefined,
  fallback: Export3DColorMode = "orientation",
): Export3DColorMode {
  const token = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!token) return fallback;
  if (
    token === "hsl" ||
    token === "hsl_direction" ||
    token === "hsl_sphere" ||
    token === "hslsphere"
  ) {
    return "orientation";
  }
  return COLOR_MODES.has(token as Export3DColorMode)
    ? (token as Export3DColorMode)
    : fallback;
}

export function normalizeExport3DScalarPalette(
  value: string | null | undefined,
  fallback: Export3DScalarPalette = "viridis",
): Export3DScalarPalette {
  const token = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (token === "twilight") return "twilight";
  if (fallback === "twilight" && !token) return "twilight";
  return normalizeScalarColorPalette(
    value,
    fallback === "twilight" ? "viridis" : fallback,
  );
}

export function isDivergingExport3DPalette(palette: string): boolean {
  const normalized = normalizeExport3DScalarPalette(palette);
  if (normalized === "twilight") return false;
  return isDivergingScalarPalette(normalized);
}

function interpolateStopsSrgb(
  t: number,
  stops: readonly (readonly [number, number, number])[],
): [number, number, number] {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5;
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const fraction = scaled - index;
  const start = stops[index]!;
  const end = stops[index + 1]!;
  return [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
    start[2] + (end[2] - start[2]) * fraction,
  ];
}

/** Samples any Fullmag scalar palette (including twilight) in display sRGB. */
export function evaluateScalarPaletteSrgb(
  t: number,
  palette: string | null | undefined = "viridis",
): [number, number, number] {
  const normalized = normalizeExport3DScalarPalette(palette);
  const safeT = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5;
  if (normalized === "twilight") {
    return interpolateStopsSrgb(safeT, getScalarColorPaletteStops("twilight"));
  }
  return scalarColorSrgb(safeT, normalized);
}

/** Samples any Fullmag scalar palette (including twilight) in linear-sRGB. */
export function evaluateScalarPaletteLinear(
  t: number,
  palette: string | null | undefined = "viridis",
): [number, number, number] {
  const normalized = normalizeExport3DScalarPalette(palette);
  if (normalized === "twilight") {
    return srgbToLinearRgb(evaluateScalarPaletteSrgb(t, "twilight"));
  }
  return scalarColorRgb(
    Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5,
    normalized,
  );
}

export function evaluateDirectionSrgb(
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return [...DIRECTION_HSL_NEUTRAL_RGB];
  }
  return directionHslSrgb(x, y, z);
}

export function evaluateDirectionLinear(
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return srgbToLinearRgb(evaluateDirectionSrgb(x, y, z));
}

export function normalizeScalarAgainstRange(
  value: number,
  range: Export3DScalarRange,
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.min >= range.max
  ) {
    return 0.5;
  }
  if (value <= range.min) return 0;
  if (value >= range.max) return 1;
  const span = range.max - range.min;
  if (Number.isFinite(span)) {
    return (value - range.min) / span;
  }
  const scale = Math.max(Math.abs(range.min), Math.abs(range.max));
  return (value / scale - range.min / scale) / (range.max / scale - range.min / scale);
}

export function extractScalarValueForMode(
  mode: Export3DColorMode,
  componentCount: 1 | 3,
  x: number,
  y = 0,
  z = 0,
): number {
  if (componentCount === 1) return x;
  if (mode === "x") return x;
  if (mode === "y") return y;
  if (mode === "z") return z;
  return Math.hypot(x, y, z);
}

export function resolveComplexPhaseSigns(
  phasorConvention?: PhasorConvention,
  floquetSpatialConvention?: FloquetSpatialConvention,
): { temporalPhaseSign: 1 | -1; spatialPhaseSign: 1 | -1 } {
  const temporalPhaseSign = phasorConvention
    ? phasorAdapter(phasorConvention).phaseAnimationDirection
    : 1;
  const spatialPhaseSign = floquetSpatialConvention
    ? floquetPhaseAdapter(floquetSpatialConvention).spatialPhaseSign
    : -1;
  return { temporalPhaseSign, spatialPhaseSign };
}

function safeAtan2(y: number, x: number): number {
  if (Math.abs(x) < 1e-30 && Math.abs(y) < 1e-30) return 0;
  return Math.atan2(y, x);
}

function wrapPhaseRad(value: number): number {
  const shifted = (value + Math.PI) % TWO_PI;
  return (shifted < 0 ? shifted + TWO_PI : shifted) - Math.PI;
}

export function computeFloquetSpatialPhaseRad(
  posM: readonly [number, number, number] | null | undefined,
  wavevectorKf: readonly [number, number, number] | null | undefined,
  cellOriginM: readonly [number, number, number] | null | undefined,
  spatialPhaseSign: 1 | -1,
): number {
  if (!posM || !wavevectorKf) return 0;
  const ox = cellOriginM?.[0] ?? 0;
  const oy = cellOriginM?.[1] ?? 0;
  const oz = cellOriginM?.[2] ?? 0;
  const dx = posM[0] - ox;
  const dy = posM[1] - oy;
  const dz = posM[2] - oz;
  return spatialPhaseSign * (wavevectorKf[0] * dx + wavevectorKf[1] * dy + wavevectorKf[2] * dz);
}

/**
 * Evaluates a complex scalar or 3D vector phasor at one position and temporal
 * phase, matching Fullmag's GPU shader convention (`viewport3dScalarSurfaceShader.ts`):
 * `theta = temporalPhaseSign * phaseRad + (floquetActive ? spatialPhaseSign * dot(kF, pos - origin) : 0)`
 * `phase_rotated_real = amplitudeScale * (real * cos(theta) - imag * sin(theta))`.
 */
export function evaluateComplexFieldTuple(params: {
  reX: number;
  reY: number;
  reZ: number;
  imX: number;
  imY: number;
  imZ: number;
  phaseRad: number;
  temporalPhaseSign: 1 | -1;
  spatialPhaseOffsetRad?: number;
  amplitudeScale?: number;
  representation?: Export3DComplexRepresentation;
  componentCount: 1 | 3;
}): [number, number, number] {
  const amp = params.amplitudeScale ?? 1;
  const repr = params.representation ?? "phase_rotated_real";
  if (repr === "real") {
    return [amp * params.reX, amp * params.reY, amp * params.reZ];
  }
  if (repr === "imag") {
    return [amp * params.imX, amp * params.imY, amp * params.imZ];
  }
  if (repr === "abs") {
    return [
      amp * Math.hypot(params.reX, params.imX),
      amp * Math.hypot(params.reY, params.imY),
      amp * Math.hypot(params.reZ, params.imZ),
    ];
  }
  if (repr === "phase") {
    if (params.componentCount === 1) {
      return [safeAtan2(params.imX, params.reX), 0, 0];
    }
    return [
      safeAtan2(params.imX, params.reX),
      safeAtan2(params.imY, params.reY),
      safeAtan2(params.imZ, params.reZ),
    ];
  }

  const rawTheta =
    params.temporalPhaseSign * params.phaseRad +
    (params.spatialPhaseOffsetRad ?? 0);
  const theta = wrapPhaseRad(rawTheta);
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  return [
    amp * (params.reX * cosTheta - params.imX * sinTheta),
    amp * (params.reY * cosTheta - params.imY * sinTheta),
    amp * (params.reZ * cosTheta - params.imZ * sinTheta),
  ];
}

/**
 * Evaluates a complex field at `phaseRad` into a packed Float32Array matching
 * `field.realValues` layout (`entryCount * field.componentCount`).
 */
export function evaluateComplexFieldArray(
  field: Export3DComplexFieldInput,
  phaseRad: number,
  entryPositionsM?: Export3DNumericArray | null,
): Float32Array {
  const nComp = field.componentCount;
  const entryCount = Math.floor(
    Math.min(field.realValues.length, field.imagValues.length) / nComp,
  );
  const out = new Float32Array(entryCount * nComp);
  const { temporalPhaseSign, spatialPhaseSign } = resolveComplexPhaseSigns(
    field.phasorConvention,
    field.floquetSpatialConvention,
  );
  const hasFloquet = Boolean(field.wavevectorKf && entryPositionsM);
  const kf = field.wavevectorKf ?? [0, 0, 0];
  const origin = field.cellOriginM ?? [0, 0, 0];
  const amp = Number.isFinite(field.amplitudeScale) ? (field.amplitudeScale ?? 1) : 1;
  const repr = field.complexRepresentation ?? "phase_rotated_real";

  for (let i = 0; i < entryCount; i += 1) {
    const base = i * nComp;
    const posIndex = field.nodeIndices ? (field.nodeIndices[i] ?? i) : i;
    let spatialOffset = 0;
    if (hasFloquet && entryPositionsM && posIndex * 3 + 2 < entryPositionsM.length) {
      const px = entryPositionsM[posIndex * 3] ?? 0;
      const py = entryPositionsM[posIndex * 3 + 1] ?? 0;
      const pz = entryPositionsM[posIndex * 3 + 2] ?? 0;
      spatialOffset =
        spatialPhaseSign *
        (kf[0] * (px - origin[0]) +
          kf[1] * (py - origin[1]) +
          kf[2] * (pz - origin[2]));
    }
    const reX = field.realValues[base] ?? 0;
    const imX = field.imagValues[base] ?? 0;
    const reY = nComp === 3 ? (field.realValues[base + 1] ?? 0) : 0;
    const imY = nComp === 3 ? (field.imagValues[base + 1] ?? 0) : 0;
    const reZ = nComp === 3 ? (field.realValues[base + 2] ?? 0) : 0;
    const imZ = nComp === 3 ? (field.imagValues[base + 2] ?? 0) : 0;
    const [vx, vy, vz] = evaluateComplexFieldTuple({
      reX,
      reY,
      reZ,
      imX,
      imY,
      imZ,
      phaseRad,
      temporalPhaseSign,
      spatialPhaseOffsetRad: spatialOffset,
      amplitudeScale: amp,
      representation: repr,
      componentCount: nComp,
    });
    out[base] = vx;
    if (nComp === 3) {
      out[base + 1] = vy;
      out[base + 2] = vz;
    }
  }
  return out;
}

/**
 * Computes exact harmonic quadrature basis fields `(cosBasis, sinBasis)` such that
 * `field(phi) = cos(phi) * cosBasis + sin(phi) * sinBasis` for `phase_rotated_real`
 * even when Floquet spatial phase is active.
 */
export function evaluateComplexHarmonicQuadratureBasis(
  field: Export3DComplexFieldInput,
  entryPositionsM?: Export3DNumericArray | null,
): { cosBasis: Float32Array; sinBasis: Float32Array } {
  const nComp = field.componentCount;
  const entryCount = Math.floor(
    Math.min(field.realValues.length, field.imagValues.length) / nComp,
  );
  const cosBasis = new Float32Array(entryCount * nComp);
  const sinBasis = new Float32Array(entryCount * nComp);
  const { temporalPhaseSign, spatialPhaseSign } = resolveComplexPhaseSigns(
    field.phasorConvention,
    field.floquetSpatialConvention,
  );
  const hasFloquet = Boolean(field.wavevectorKf && entryPositionsM);
  const kf = field.wavevectorKf ?? [0, 0, 0];
  const origin = field.cellOriginM ?? [0, 0, 0];
  const amp = Number.isFinite(field.amplitudeScale) ? (field.amplitudeScale ?? 1) : 1;

  for (let i = 0; i < entryCount; i += 1) {
    const base = i * nComp;
    const posIndex = field.nodeIndices ? (field.nodeIndices[i] ?? i) : i;
    let alpha = 0;
    if (hasFloquet && entryPositionsM && posIndex * 3 + 2 < entryPositionsM.length) {
      const px = entryPositionsM[posIndex * 3] ?? 0;
      const py = entryPositionsM[posIndex * 3 + 1] ?? 0;
      const pz = entryPositionsM[posIndex * 3 + 2] ?? 0;
      alpha =
        spatialPhaseSign *
        (kf[0] * (px - origin[0]) +
          kf[1] * (py - origin[1]) +
          kf[2] * (pz - origin[2]));
    }
    const cosAlpha = Math.cos(alpha);
    const sinAlpha = Math.sin(alpha);
    for (let c = 0; c < nComp; c += 1) {
      const re = field.realValues[base + c] ?? 0;
      const im = field.imagValues[base + c] ?? 0;
      cosBasis[base + c] = amp * (re * cosAlpha - im * sinAlpha);
      sinBasis[base + c] =
        amp * (-temporalPhaseSign * (re * sinAlpha + im * cosAlpha));
    }
  }
  return { cosBasis, sinBasis };
}

export function resolveFieldScalarRange(
  framesValues: readonly Export3DNumericArray[],
  componentCount: 1 | 3,
  colorMode: Export3DColorMode,
  colorPalette: Export3DScalarPalette,
  explicitRange?: Export3DScalarRange | null,
): Export3DScalarRange {
  if (
    explicitRange &&
    Number.isFinite(explicitRange.min) &&
    Number.isFinite(explicitRange.max)
  ) {
    return { min: explicitRange.min, max: explicitRange.max };
  }

  let min = Infinity;
  let max = -Infinity;

  for (const values of framesValues) {
    const count = Math.floor(values.length / componentCount);
    for (let i = 0; i < count; i += 1) {
      const base = i * componentCount;
      const x = values[base] ?? 0;
      const y = componentCount === 3 ? (values[base + 1] ?? 0) : 0;
      const z = componentCount === 3 ? (values[base + 2] ?? 0) : 0;
      const scalar = extractScalarValueForMode(colorMode, componentCount, x, y, z);
      if (!Number.isFinite(scalar)) continue;
      if (scalar < min) min = scalar;
      if (scalar > max) max = scalar;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }

  const isSignedComponent =
    componentCount === 3 &&
    (colorMode === "x" || colorMode === "y" || colorMode === "z");
  if (isSignedComponent && isDivergingExport3DPalette(colorPalette)) {
    const maxAbs = Math.max(Math.abs(min), Math.abs(max));
    return { min: -maxAbs, max: maxAbs };
  }
  return { min, max };
}

export function evaluateVectorColorSrgb(
  mode: Export3DColorMode,
  palette: Export3DScalarPalette,
  range: Export3DScalarRange,
  componentCount: 1 | 3,
  x: number,
  y = 0,
  z = 0,
  monochromeColor: Export3DRgbTuple = DEFAULT_MONOCHROME_SRGB,
): [number, number, number] {
  if (mode === "monochrome") {
    return [monochromeColor[0], monochromeColor[1], monochromeColor[2]];
  }
  if (mode === "orientation" && componentCount === 3) {
    return evaluateDirectionSrgb(x, y, z);
  }
  const scalar = extractScalarValueForMode(mode, componentCount, x, y, z);
  if (!Number.isFinite(scalar)) {
    return [...MISSING_COVERAGE_SRGB];
  }
  const t = normalizeScalarAgainstRange(scalar, range);
  return evaluateScalarPaletteSrgb(t, palette);
}

export function evaluateVectorColorLinear(
  mode: Export3DColorMode,
  palette: Export3DScalarPalette,
  range: Export3DScalarRange,
  componentCount: 1 | 3,
  x: number,
  y = 0,
  z = 0,
  monochromeColor: Export3DRgbTuple = DEFAULT_MONOCHROME_SRGB,
): [number, number, number] {
  if (mode === "monochrome") {
    return srgbToLinearRgb(monochromeColor);
  }
  if (mode === "orientation" && componentCount === 3) {
    return evaluateDirectionLinear(x, y, z);
  }
  const scalar = extractScalarValueForMode(mode, componentCount, x, y, z);
  if (!Number.isFinite(scalar)) {
    return srgbToLinearRgb(MISSING_COVERAGE_SRGB);
  }
  const t = normalizeScalarAgainstRange(scalar, range);
  return evaluateScalarPaletteLinear(t, palette);
}

export function buildFieldEntryResolver(
  nodeIndices: Export3DIndexArray | null | undefined,
  entryCount: number,
  domainEntryCount: number,
): ((targetIndex: number) => number | null) {
  if (!nodeIndices) {
    return (targetIndex) =>
      targetIndex >= 0 && targetIndex < entryCount ? targetIndex : null;
  }
  const map = new Map<number, number>();
  const count = Math.min(entryCount, nodeIndices.length);
  for (let fieldIdx = 0; fieldIdx < count; fieldIdx += 1) {
    const targetIdx = nodeIndices[fieldIdx];
    if (
      targetIdx !== undefined &&
      Number.isInteger(targetIdx) &&
      targetIdx >= 0 &&
      targetIdx < domainEntryCount
    ) {
      map.set(targetIdx, fieldIdx);
    }
  }
  return (targetIndex) => map.get(targetIndex) ?? null;
}

export interface EvaluateFieldColorsParams {
  values: Export3DNumericArray;
  componentCount: 1 | 3;
  colorMode: Export3DColorMode;
  colorPalette: Export3DScalarPalette;
  range: Export3DScalarRange;
  outputTargetIndices?: Export3DIndexArray | null;
  outputCount?: number;
  domainEntryCount?: number;
  fieldNodeIndices?: Export3DIndexArray | null;
  compactActiveIndexMap?: ReadonlyMap<number, number> | null;
  monochromeColor?: Export3DRgbTuple;
}

/**
 * Evaluates linear-sRGB `[0, 1]` vertex color triples (ready for glTF `COLOR_0`).
 */
export function evaluateFieldColorsLinear(
  params: EvaluateFieldColorsParams,
): Float32Array {
  const nComp = params.componentCount;
  const fieldEntryCount = Math.floor(params.values.length / nComp);
  const count = params.outputCount ?? params.outputTargetIndices?.length ?? fieldEntryCount;
  const domainCount = params.domainEntryCount ?? count;
  const resolveFieldEntry = params.compactActiveIndexMap
    ? (targetIndex: number) => params.compactActiveIndexMap!.get(targetIndex) ?? null
    : buildFieldEntryResolver(params.fieldNodeIndices, fieldEntryCount, domainCount);

  const colors = new Float32Array(count * 3);
  const fallbackLinear = srgbToLinearRgb(MISSING_COVERAGE_SRGB);
  const monoColor = params.monochromeColor ?? DEFAULT_MONOCHROME_SRGB;

  for (let outIdx = 0; outIdx < count; outIdx += 1) {
    const targetIndex = params.outputTargetIndices
      ? (params.outputTargetIndices[outIdx] ?? -1)
      : outIdx;
    const fieldIndex = resolveFieldEntry(targetIndex);
    const dst = outIdx * 3;
    if (fieldIndex === null || fieldIndex < 0 || fieldIndex >= fieldEntryCount) {
      colors[dst] = fallbackLinear[0];
      colors[dst + 1] = fallbackLinear[1];
      colors[dst + 2] = fallbackLinear[2];
      continue;
    }
    const src = fieldIndex * nComp;
    const x = params.values[src] ?? 0;
    const y = nComp === 3 ? (params.values[src + 1] ?? 0) : 0;
    const z = nComp === 3 ? (params.values[src + 2] ?? 0) : 0;
    const rgb = evaluateVectorColorLinear(
      params.colorMode,
      params.colorPalette,
      params.range,
      nComp,
      x,
      y,
      z,
      monoColor,
    );
    colors[dst] = rgb[0];
    colors[dst + 1] = rgb[1];
    colors[dst + 2] = rgb[2];
  }
  return colors;
}

/**
 * Evaluates sRGB UInt8 `[0..255]` triples (for VTK `magnetic_texture_rgb`).
 */
export function evaluateFieldColorsSrgbUInt8(
  params: EvaluateFieldColorsParams,
): Uint8Array {
  const nComp = params.componentCount;
  const fieldEntryCount = Math.floor(params.values.length / nComp);
  const count = params.outputCount ?? params.outputTargetIndices?.length ?? fieldEntryCount;
  const domainCount = params.domainEntryCount ?? count;
  const resolveFieldEntry = params.compactActiveIndexMap
    ? (targetIndex: number) => params.compactActiveIndexMap!.get(targetIndex) ?? null
    : buildFieldEntryResolver(params.fieldNodeIndices, fieldEntryCount, domainCount);

  const colors = new Uint8Array(count * 3);
  const monoColor = params.monochromeColor ?? DEFAULT_MONOCHROME_SRGB;

  for (let outIdx = 0; outIdx < count; outIdx += 1) {
    const targetIndex = params.outputTargetIndices
      ? (params.outputTargetIndices[outIdx] ?? -1)
      : outIdx;
    const fieldIndex = resolveFieldEntry(targetIndex);
    const dst = outIdx * 3;
    if (fieldIndex === null || fieldIndex < 0 || fieldIndex >= fieldEntryCount) {
      colors[dst] = Math.round(MISSING_COVERAGE_SRGB[0] * 255);
      colors[dst + 1] = Math.round(MISSING_COVERAGE_SRGB[1] * 255);
      colors[dst + 2] = Math.round(MISSING_COVERAGE_SRGB[2] * 255);
      continue;
    }
    const src = fieldIndex * nComp;
    const x = params.values[src] ?? 0;
    const y = nComp === 3 ? (params.values[src + 1] ?? 0) : 0;
    const z = nComp === 3 ? (params.values[src + 2] ?? 0) : 0;
    const srgb = evaluateVectorColorSrgb(
      params.colorMode,
      params.colorPalette,
      params.range,
      nComp,
      x,
      y,
      z,
      monoColor,
    );
    colors[dst] = Math.min(255, Math.max(0, Math.round(srgb[0] * 255)));
    colors[dst + 1] = Math.min(255, Math.max(0, Math.round(srgb[1] * 255)));
    colors[dst + 2] = Math.min(255, Math.max(0, Math.round(srgb[2] * 255)));
  }
  return colors;
}

/**
 * Quantizes linear-sRGB values to a bounded palette key so animated 3D arrows
 * share a small number of Three.js materials instead of one per arrow node.
 */
export function quantizeLinearRgb(
  rgb: Export3DRgbTuple,
  levelsPerChannel = 4,
): { key: string; rgb: [number, number, number] } {
  const safeLevels = Math.max(2, Math.floor(levelsPerChannel));
  const denom = safeLevels - 1;
  const q = rgb.map((channel) => {
    const clamped = Number.isFinite(channel) ? Math.min(1, Math.max(0, channel)) : 0;
    const srgb = linearToSrgbChannel(clamped);
    const bucket = Math.round(srgb * denom);
    return bucket;
  }) as [number, number, number];
  const key = `${q[0]}_${q[1]}_${q[2]}`;
  const quantizedLinear = srgbToLinearRgb([q[0] / denom, q[1] / denom, q[2] / denom]);
  return { key, rgb: quantizedLinear };
}
