import {
  BufferAttribute,
  BufferGeometry,
  ShaderMaterial,
  type Side,
} from "three";

import {
  floquetPhaseAdapter,
  phasorAdapter,
} from "@/shared/domain/analysis/phasorConventionAdapter";

import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import {
  normalizeViewport3DColorPalette,
  normalizeViewport3DVectorColorMode,
} from "./viewport3dVectorColoring";

export const VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE = "fmScalarValue";
export const VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE = "fmVectorValue";
export const VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE = "fmComplexRealValue";
export const VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE = "fmComplexImagValue";

export interface Viewport3DScalarSurfaceShaderOptions {
  depthTest: boolean;
  depthWrite: boolean;
  opacity: number;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  shadeStrength?: number;
  side: Side;
  toneMapped?: boolean;
  transparent: boolean;
}

const DEFAULT_SCALAR_SURFACE_SHADE_STRENGTH = 0.45;

export function canApplyScalarShaderColorBuffer(
  buffer: ScalarColorBuffer | null | undefined,
  vertexCount: number,
): boolean {
  if (!buffer) return false;
  const hasScalarValues = Boolean(
    buffer.scalarValues && buffer.scalarValues.length === vertexCount,
  );
  const hasVectorValues = Boolean(
    buffer.vectorValues && buffer.vectorValues.length === vertexCount * 3,
  );
  const hasComplexValues = canApplyComplexShaderColorBuffer(buffer, vertexCount);
  return Boolean(
    (hasScalarValues || hasVectorValues || hasComplexValues) &&
      Number.isFinite(buffer.range.min) &&
      Number.isFinite(buffer.range.max),
  );
}

export function applyScalarShaderColorBuffer(
  geometry: BufferGeometry,
  buffer: ScalarColorBuffer | null | undefined,
  vertexCount: number,
): boolean {
  const scalarValues = buffer?.scalarValues;
  const vectorValues = buffer?.vectorValues;
  const hasScalarValues = Boolean(
    scalarValues && scalarValues.length === vertexCount,
  );
  const hasVectorValues = Boolean(
    vectorValues && vectorValues.length === vertexCount * 3,
  );
  const hasComplexValues = canApplyComplexShaderColorBuffer(buffer, vertexCount);

  if (!hasScalarValues && !hasVectorValues && !hasComplexValues) {
    deleteShaderAttributes(geometry);
    return false;
  }

  if (hasScalarValues && scalarValues) {
    setFloatAttribute(
      geometry,
      VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
      scalarValues,
      1,
      vertexCount,
    );
  } else if (geometry.hasAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)) {
    geometry.deleteAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE);
  }

  if (hasVectorValues && vectorValues) {
    setFloatAttribute(
      geometry,
      VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
      vectorValues,
      3,
      vertexCount,
    );
  } else if (geometry.hasAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE)) {
    geometry.deleteAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE);
  }

  if (hasComplexValues && buffer?.complexRealValues && buffer.complexImagValues) {
    setFloatAttribute(
      geometry,
      VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE,
      buffer.complexRealValues,
      3,
      vertexCount,
    );
    setFloatAttribute(
      geometry,
      VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE,
      buffer.complexImagValues,
      3,
      vertexCount,
    );
  } else {
    if (geometry.hasAttribute(VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE)) {
      geometry.deleteAttribute(VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE);
    }
    if (geometry.hasAttribute(VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE)) {
      geometry.deleteAttribute(VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE);
    }
  }

  return true;
}

export function createScalarSurfaceShaderMaterial(
  buffer: ScalarColorBuffer,
  options: Viewport3DScalarSurfaceShaderOptions,
): ShaderMaterial {
  const colorModeId = shaderColorModeId(buffer.colorMode);
  const orientationMode = colorModeId === 1;
  const complexMode = hasComplexShaderValues(buffer);
  const spatialPhaseSign = buffer.floquetSpatialConvention
    ? floquetPhaseAdapter(buffer.floquetSpatialConvention as Parameters<typeof floquetPhaseAdapter>[0]).spatialPhaseSign
    : -1;
  const temporalPhaseSign = buffer.phasorConvention
    ? phasorAdapter(buffer.phasorConvention as Parameters<typeof phasorAdapter>[0]).phaseAnimationDirection
    : 1;
  const floquetActive = buffer.wavevectorKf ? 1 : 0;
  const material = new ShaderMaterial({
    clipping: true,
    depthTest: options.depthTest,
    depthWrite: options.depthWrite,
    fragmentShader: orientationMode
      ? ORIENTATION_SURFACE_FRAGMENT_SHADER
      : SCALAR_SURFACE_FRAGMENT_SHADER,
    name: "FullmagScalarSurfaceShaderMaterial",
    polygonOffset: options.polygonOffset,
    polygonOffsetFactor: options.polygonOffsetFactor,
    polygonOffsetUnits: options.polygonOffsetUnits,
    side: options.side,
    transparent: options.transparent,
    uniforms: {
      fmColorModeId: { value: colorModeId },
      fmAmplitudeScale: { value: finiteAmplitudeScale(buffer.amplitudeScale) },
      fmOpacity: { value: options.opacity },
      fmPaletteId: { value: scalarPaletteId(buffer.colorPalette) },
      fmPhaseRad: { value: finitePhaseRad(buffer.complexPhaseRad) ?? 0 },
      fmRepresentationId: {
        value: complexRepresentationId(buffer.complexRepresentation),
      },
      fmScalarMax: {
        value: Number.isFinite(buffer.range?.max) ? buffer.range.max : 0,
      },
      fmScalarMin: {
        value: Number.isFinite(buffer.range?.min) ? buffer.range.min : 0,
      },
      fmShadeStrength: {
        value: Number.isFinite(options.shadeStrength)
          ? (options.shadeStrength as number)
          : DEFAULT_SCALAR_SURFACE_SHADE_STRENGTH,
      },
      fmWavevectorKf: { value: buffer.wavevectorKf ?? [0, 0, 0] },
      fmCellOrigin: { value: buffer.cellOrigin ?? [0, 0, 0] },
      fmSpatialPhaseSign: { value: spatialPhaseSign },
      fmTemporalPhaseSign: { value: temporalPhaseSign },
      fmFloquetActive: { value: floquetActive },
    },
    vertexShader: resolveSurfaceVertexShader(orientationMode, complexMode),
  });
  material.toneMapped = options.toneMapped ?? false;
  return material;
}

/**
 * Stable identifier for "which of the four vertex/fragment shader variants"
 * a given buffer would select (scalar/orientation × real/complex). Used by
 * consumers (MeshPartLayer.tsx) to decide when a ShaderMaterial must be
 * recreated (program shape changed) vs. merely updated in place via
 * updateScalarSurfaceShaderMaterial (data changed, e.g. per-frame phase
 * animation) — see S-08.
 */
export function scalarSurfaceShaderVariantKey(buffer: ScalarColorBuffer): string {
  const colorModeId = shaderColorModeId(buffer.colorMode);
  const orientationMode = colorModeId === 1;
  const complexMode = hasComplexShaderValues(buffer);
  return `${orientationMode ? "orientation" : "scalar"}:${complexMode ? "complex" : "real"}`;
}

export function updateScalarSurfaceShaderMaterial(
  material: ShaderMaterial,
  buffer: ScalarColorBuffer,
  opacity: number,
  shadeStrength?: number,
): void {
  const nextColorModeId = shaderColorModeId(buffer.colorMode);
  const orientationMode = nextColorModeId === 1;
  const nextVertexShader = resolveSurfaceVertexShader(
    orientationMode,
    hasComplexShaderValues(buffer),
  );
  const nextFragmentShader = orientationMode
    ? ORIENTATION_SURFACE_FRAGMENT_SHADER
    : SCALAR_SURFACE_FRAGMENT_SHADER;

  if (
    material.vertexShader !== nextVertexShader ||
    material.fragmentShader !== nextFragmentShader
  ) {
    material.vertexShader = nextVertexShader;
    material.fragmentShader = nextFragmentShader;
    material.needsUpdate = true;
  }

  const spatialPhaseSign = buffer.floquetSpatialConvention
    ? floquetPhaseAdapter(buffer.floquetSpatialConvention as Parameters<typeof floquetPhaseAdapter>[0]).spatialPhaseSign
    : -1;
  const temporalPhaseSign = buffer.phasorConvention
    ? phasorAdapter(buffer.phasorConvention as Parameters<typeof phasorAdapter>[0]).phaseAnimationDirection
    : 1;
  const floquetActive = buffer.wavevectorKf ? 1 : 0;

  material.uniforms.fmColorModeId.value = nextColorModeId;
  material.uniforms.fmAmplitudeScale.value = finiteAmplitudeScale(
    buffer.amplitudeScale,
  );
  material.uniforms.fmOpacity.value = opacity;
  material.uniforms.fmPaletteId.value = scalarPaletteId(buffer.colorPalette);
  material.uniforms.fmPhaseRad.value = finitePhaseRad(buffer.complexPhaseRad) ?? 0;
  material.uniforms.fmRepresentationId.value = complexRepresentationId(
    buffer.complexRepresentation,
  );
  material.uniforms.fmScalarMax.value = Number.isFinite(buffer.range?.max)
    ? buffer.range.max
    : 0;
  material.uniforms.fmScalarMin.value = Number.isFinite(buffer.range?.min)
    ? buffer.range.min
    : 0;
  material.uniforms.fmShadeStrength.value = Number.isFinite(shadeStrength)
    ? (shadeStrength as number)
    : DEFAULT_SCALAR_SURFACE_SHADE_STRENGTH;
  material.uniforms.fmWavevectorKf.value = buffer.wavevectorKf ?? [0, 0, 0];
  material.uniforms.fmCellOrigin.value = buffer.cellOrigin ?? [0, 0, 0];
  material.uniforms.fmSpatialPhaseSign.value = spatialPhaseSign;
  material.uniforms.fmTemporalPhaseSign.value = temporalPhaseSign;
  material.uniforms.fmFloquetActive.value = floquetActive;
}

function canApplyComplexShaderColorBuffer(
  buffer: ScalarColorBuffer | null | undefined,
  vertexCount: number,
): boolean {
  return Boolean(
    buffer?.complexRealValues &&
      buffer.complexImagValues &&
      buffer.complexRealValues.length === vertexCount * 3 &&
      buffer.complexImagValues.length === vertexCount * 3,
  );
}

function hasComplexShaderValues(buffer: ScalarColorBuffer): boolean {
  return canApplyComplexShaderColorBuffer(
    buffer,
    (buffer.complexRealValues?.length ?? 0) / 3,
  );
}

function finitePhaseRad(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteAmplitudeScale(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function complexRepresentationId(
  representation: ScalarColorBuffer["complexRepresentation"],
): number {
  switch (representation) {
    case "real":
      return 1;
    case "imag":
      return 2;
    case "abs":
      return 3;
    case "phase":
      return 4;
    case "phase_rotated_real":
    default:
      return 0;
  }
}

function resolveSurfaceVertexShader(
  orientationMode: boolean,
  complexMode: boolean,
): string {
  if (complexMode) {
    return orientationMode
      ? COMPLEX_ORIENTATION_SURFACE_VERTEX_SHADER
      : COMPLEX_SCALAR_SURFACE_VERTEX_SHADER;
  }
  return orientationMode
    ? ORIENTATION_SURFACE_VERTEX_SHADER
    : SCALAR_SURFACE_VERTEX_SHADER;
}

function setFloatAttribute(
  geometry: BufferGeometry,
  name: string,
  values: Float32Array,
  itemSize: number,
  vertexCount: number,
): void {
  const existing = geometry.getAttribute(name);
  if (
    existing instanceof BufferAttribute &&
    existing.itemSize === itemSize &&
    existing.count === vertexCount &&
    existing.array instanceof Float32Array
  ) {
    (existing.array as Float32Array).set(values);
    existing.needsUpdate = true;
    return;
  }

  geometry.setAttribute(name, new BufferAttribute(values, itemSize));
}

function deleteShaderAttributes(geometry: BufferGeometry): void {
  if (geometry.hasAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)) {
    geometry.deleteAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE);
  }
  if (geometry.hasAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE)) {
    geometry.deleteAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE);
  }
  if (geometry.hasAttribute(VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE)) {
    geometry.deleteAttribute(VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE);
  }
  if (geometry.hasAttribute(VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE)) {
    geometry.deleteAttribute(VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE);
  }
}

function shaderColorModeId(mode: string | null | undefined): number {
  switch (normalizeViewport3DVectorColorMode(mode, "magnitude")) {
    case "orientation":
      return 1;
    case "x":
      return 2;
    case "y":
      return 3;
    case "z":
      return 4;
    case "magnitude":
    case "monochrome":
      return 0;
  }
}

function scalarPaletteId(palette: string | null | undefined): number {
  if (palette?.trim().toLowerCase().replace(/[\s-]+/g, "_") === "twilight") {
    return 5;
  }

  switch (normalizeViewport3DColorPalette(palette)) {
    case "coolwarm":
      return 1;
    case "inferno":
      return 2;
    case "jet":
      return 3;
    case "magma":
      return 4;
    case "viridis":
      return 0;
  }
}

const SCALAR_SURFACE_VERTEX_SHADER = `
attribute float ${VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE};
varying float vScalarValue;
varying vec3 vNormalView;

#include <clipping_planes_pars_vertex>

void main() {
  vScalarValue = ${VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE};
  vNormalView = normalMatrix * normal;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const ORIENTATION_SURFACE_VERTEX_SHADER = `
attribute vec3 ${VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE};
varying vec3 vVectorValue;
varying vec3 vNormalView;

#include <clipping_planes_pars_vertex>

void main() {
  vVectorValue = ${VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE};
  vNormalView = normalMatrix * normal;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const COMPLEX_SCALAR_SURFACE_VERTEX_SHADER = `
attribute vec3 ${VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE};
attribute vec3 ${VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE};
uniform int fmColorModeId;
uniform int fmRepresentationId;
uniform float fmPhaseRad;
uniform float fmAmplitudeScale;
uniform vec3 fmWavevectorKf;
uniform vec3 fmCellOrigin;
uniform float fmSpatialPhaseSign;
uniform float fmTemporalPhaseSign;
uniform int fmFloquetActive;
uniform float fmScalarMin;
uniform float fmScalarMax;
varying float vScalarValue;
varying vec3 vNormalView;

#include <clipping_planes_pars_vertex>

// S-12: GLSL ES leaves atan(y, x) undefined when x == y == 0.0 (e.g. nodes
// with zero mode amplitude -- air, out-of-support cells). Guard it so the
// result is deterministic across drivers (Mesa / ANGLE / Metal disagree).
float safeAtan2(float y, float x) {
  return (abs(x) < 1e-30 && abs(y) < 1e-30) ? 0.0 : atan(y, x);
}

const float FM_PI = 3.141592653589793;
const float FM_TWO_PI = 6.283185307179586;

// S-13: k in micromagnetics is on the order of 1e7-1e8 rad/m; for a cell
// size of 1e-6-1e-5 m the Floquet spatial phase term
// dot(fmWavevectorKf, position - fmCellOrigin) can reach 1e2-1e4 (more for
// larger supercells). GLSL ES sin/cos give no accuracy guarantee outside a
// small argument range: ANGLE/D3D and mobile drivers lose precision in
// their own argument reduction once |theta| grows large, turning a smooth
// traveling wave into phase noise that differs between Chrome/ANGLE and
// Firefox/Metal, and drifts frame-to-frame during animation. Wrapping
// theta into [-PI, PI] right after the (potentially huge) spatial term is
// added keeps the sin/cos argument small and the reduction accurate on
// every driver.
float wrapPhase(float value) {
  return mod(value + FM_PI, FM_TWO_PI) - FM_PI;
}

float scalarFromVector(vec3 value) {
  // S-12: for the "phase" representation, projectComplex below already
  // resolves the single correct phase value for whichever colorMode is
  // selected (including a dedicated magnitude-of-phase formula) and
  // replicates it across all 3 components -- so length(value) here would
  // wrongly scale a single phase by sqrt(3). Read it back directly instead.
  if (fmRepresentationId == 4) return value.x;
  if (fmColorModeId == 2) return value.x;
  if (fmColorModeId == 3) return value.y;
  if (fmColorModeId == 4) return value.z;
  return length(value);
}

vec3 projectComplex(vec3 complexReal, vec3 complexImag, float theta) {
  if (fmRepresentationId == 1) return fmAmplitudeScale * complexReal;
  if (fmRepresentationId == 2) return fmAmplitudeScale * complexImag;
  if (fmRepresentationId == 3) {
    return fmAmplitudeScale * sqrt(complexReal * complexReal + complexImag * complexImag);
  }
  if (fmRepresentationId == 4) {
    // S-12: "phase" is only well-defined per selected component (or, for
    // magnitude mode, as a single amplitude-weighted combined phase) -- not
    // as three independent per-axis phases fed through length().
    float phase;
    if (fmColorModeId == 2) {
      phase = safeAtan2(complexImag.x, complexReal.x);
    } else if (fmColorModeId == 3) {
      phase = safeAtan2(complexImag.y, complexReal.y);
    } else if (fmColorModeId == 4) {
      phase = safeAtan2(complexImag.z, complexReal.z);
    } else {
      phase = safeAtan2(
        sign(dot(complexImag, complexReal)) * length(complexImag),
        length(complexReal)
      );
    }
    return vec3(phase);
  }
  return fmAmplitudeScale * (complexReal * cos(theta) - complexImag * sin(theta));
}

void main() {
  float theta = fmTemporalPhaseSign * fmPhaseRad;
  if (fmFloquetActive == 1) {
    theta += fmSpatialPhaseSign * dot(fmWavevectorKf, position - fmCellOrigin);
    // S-13: reduce the argument before it reaches cos/sin below.
    theta = wrapPhase(theta);
  }
  vec3 complexReal = ${VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE};
  vec3 complexImag = ${VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE};
  vec3 projected = projectComplex(complexReal, complexImag, theta);
  float rawScalar = scalarFromVector(projected);
  // S-07: normalize to [0, 1] here (GPU, float32) so the fragment shader can
  // treat vScalarValue uniformly with the CPU-pre-normalized plain-scalar
  // path -- see SCALAR_SURFACE_FRAGMENT_SHADER. Modal/Floquet amplitudes are
  // small oscillations rather than a large-baseline physical quantity, so
  // float32 precision here is not the concern S-07 addresses; this merely
  // relocates the existing (v - min) / span formula from the fragment stage.
  bool rawBad = !(rawScalar == rawScalar) || abs(rawScalar) > 3.0e38;
  float scale = max(abs(fmScalarMax), abs(fmScalarMin));
  float span = fmScalarMax - fmScalarMin;
  bool degenerate = span <= 1e-6 * max(scale, 1.0);
  vScalarValue = rawBad
    ? rawScalar
    : (degenerate ? 0.5 : clamp((rawScalar - fmScalarMin) / span, 0.0, 1.0));
  vNormalView = normalMatrix * normal;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const COMPLEX_ORIENTATION_SURFACE_VERTEX_SHADER = `
attribute vec3 ${VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE};
attribute vec3 ${VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE};
uniform float fmPhaseRad;
uniform int fmRepresentationId;
uniform float fmAmplitudeScale;
uniform vec3 fmWavevectorKf;
uniform vec3 fmCellOrigin;
uniform float fmSpatialPhaseSign;
uniform float fmTemporalPhaseSign;
uniform int fmFloquetActive;
varying vec3 vVectorValue;
varying vec3 vNormalView;

#include <clipping_planes_pars_vertex>

// S-12: GLSL ES leaves atan(y, x) undefined when x == y == 0.0 (e.g. nodes
// with zero mode amplitude). Guard each component so the per-axis phase
// vector is deterministic across drivers.
float safeAtan2(float y, float x) {
  return (abs(x) < 1e-30 && abs(y) < 1e-30) ? 0.0 : atan(y, x);
}

const float FM_PI = 3.141592653589793;
const float FM_TWO_PI = 6.283185307179586;

// S-13: k in micromagnetics is on the order of 1e7-1e8 rad/m; for a cell
// size of 1e-6-1e-5 m the Floquet spatial phase term
// dot(fmWavevectorKf, position - fmCellOrigin) can reach 1e2-1e4 (more for
// larger supercells). GLSL ES sin/cos give no accuracy guarantee outside a
// small argument range: ANGLE/D3D and mobile drivers lose precision in
// their own argument reduction once |theta| grows large, turning a smooth
// traveling wave into phase noise that differs between Chrome/ANGLE and
// Firefox/Metal, and drifts frame-to-frame during animation. Wrapping
// theta into [-PI, PI] right after the (potentially huge) spatial term is
// added keeps the sin/cos argument small and the reduction accurate on
// every driver.
float wrapPhase(float value) {
  return mod(value + FM_PI, FM_TWO_PI) - FM_PI;
}

vec3 projectComplex(vec3 complexReal, vec3 complexImag, float theta) {
  if (fmRepresentationId == 1) return fmAmplitudeScale * complexReal;
  if (fmRepresentationId == 2) return fmAmplitudeScale * complexImag;
  if (fmRepresentationId == 3) {
    return fmAmplitudeScale * sqrt(complexReal * complexReal + complexImag * complexImag);
  }
  if (fmRepresentationId == 4) {
    return vec3(
      safeAtan2(complexImag.x, complexReal.x),
      safeAtan2(complexImag.y, complexReal.y),
      safeAtan2(complexImag.z, complexReal.z)
    );
  }
  return fmAmplitudeScale * (complexReal * cos(theta) - complexImag * sin(theta));
}

void main() {
  float theta = fmTemporalPhaseSign * fmPhaseRad;
  if (fmFloquetActive == 1) {
    theta += fmSpatialPhaseSign * dot(fmWavevectorKf, position - fmCellOrigin);
    // S-13: reduce the argument before it reaches cos/sin below.
    theta = wrapPhase(theta);
  }
  vec3 complexReal = ${VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE};
  vec3 complexImag = ${VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE};
  vVectorValue = projectComplex(complexReal, complexImag, theta);
  vNormalView = normalMatrix * normal;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const SCALAR_SURFACE_FRAGMENT_SHADER = `
precision highp float;

uniform float fmOpacity;
uniform int fmPaletteId;
uniform float fmScalarMin;
uniform float fmScalarMax;
uniform float fmShadeStrength;
varying float vScalarValue;
varying vec3 vNormalView;

#include <clipping_planes_pars_fragment>

vec3 mixStops3(float t, vec3 a, vec3 b, vec3 c) {
  if (t < 0.5) {
    return mix(a, b, t * 2.0);
  }
  return mix(b, c, (t - 0.5) * 2.0);
}

vec3 mixStops4(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  if (t < 0.3333333) {
    return mix(a, b, t * 3.0);
  }
  if (t < 0.6666667) {
    return mix(b, c, (t - 0.3333333) * 3.0);
  }
  return mix(c, d, (t - 0.6666667) * 3.0);
}

vec3 mixStops5(float t, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  if (t < 0.25) {
    return mix(a, b, t * 4.0);
  }
  if (t < 0.5) {
    return mix(b, c, (t - 0.25) * 4.0);
  }
  if (t < 0.75) {
    return mix(c, d, (t - 0.5) * 4.0);
  }
  return mix(d, e, (t - 0.75) * 4.0);
}

vec3 paletteColor(float t) {
  if (fmPaletteId == 1) {
    return mixStops3(t, vec3(0.231, 0.298, 0.753), vec3(0.867, 0.867, 0.867), vec3(0.706, 0.016, 0.149));
  }
  if (fmPaletteId == 2) {
    return mixStops5(t, vec3(0.0, 0.0, 0.016), vec3(0.259, 0.039, 0.408), vec3(0.576, 0.169, 0.365), vec3(0.867, 0.318, 0.227), vec3(0.988, 1.0, 0.643));
  }
  if (fmPaletteId == 3) {
    return mixStops5(t, vec3(0.0, 0.0, 0.498), vec3(0.0, 0.498, 1.0), vec3(0.498, 1.0, 0.498), vec3(1.0, 0.498, 0.0), vec3(0.498, 0.0, 0.0));
  }
  if (fmPaletteId == 4) {
    return mixStops5(t, vec3(0.0, 0.0, 0.016), vec3(0.231, 0.059, 0.439), vec3(0.549, 0.161, 0.502), vec3(0.871, 0.286, 0.408), vec3(0.988, 0.992, 0.749));
  }
  if (fmPaletteId == 5) {
    return mixStops5(t, vec3(0.184, 0.079, 0.213), vec3(0.384, 0.461, 0.731), vec3(0.886, 0.85, 0.886), vec3(0.698, 0.338, 0.322), vec3(0.184, 0.079, 0.213));
  }
  return mixStops4(t, vec3(0.267, 0.004, 0.329), vec3(0.192, 0.408, 0.557), vec3(0.208, 0.718, 0.475), vec3(0.992, 0.906, 0.145));
}

vec3 srgbToLinearVec3(vec3 c) {
  vec3 lower = c / 12.92;
  vec3 higher = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lower, higher, step(vec3(0.04045), c));
}

void main() {
  #include <clipping_planes_fragment>
  float v = vScalarValue;
  bool bad = !(v == v) || abs(v) > 3.0e38;

  // S-07: vScalarValue arrives already normalized to [0, 1] in float64 on
  // the CPU (plain scalar buffers) or in the vertex shader (complex/modal
  // buffers, see COMPLEX_SCALAR_SURFACE_VERTEX_SHADER) -- no further
  // (v - min) / span division is done here at float32 precision.
  float t = bad ? 0.5 : clamp(v, 0.0, 1.0);
  vec3 base = srgbToLinearVec3(bad ? vec3(0.85, 0.0, 0.85) : paletteColor(t));
  vec3 n = normalize(vNormalView) * (gl_FrontFacing ? 1.0 : -1.0);
  float ndl = clamp(dot(n, normalize(vec3(0.35, 0.55, 0.75))) * 0.5 + 0.5, 0.0, 1.0);
  vec3 color = base * mix(1.0, 0.55 + 0.75 * ndl, fmShadeStrength);
  gl_FragColor = vec4(color, fmOpacity);
  #include <colorspace_fragment>
}
`;

const ORIENTATION_SURFACE_FRAGMENT_SHADER = `
precision highp float;

uniform float fmOpacity;
uniform float fmShadeStrength;
varying vec3 vVectorValue;
varying vec3 vNormalView;

#include <clipping_planes_pars_fragment>

const float FM_PI = 3.141592653589793;

float positiveModulo(float value, float modulus) {
  return mod(mod(value, modulus) + modulus, modulus);
}

vec3 orientationHslToRgb(float hueRadians, float saturation, float lightness) {
  float h = positiveModulo(hueRadians * 180.0 / FM_PI / 60.0, 6.0);
  float c = (1.0 - abs(2.0 * lightness - 1.0)) * saturation;
  float x = c * (1.0 - abs(positiveModulo(h, 2.0) - 1.0));
  float m = lightness - c / 2.0;

  if (h < 1.0) return vec3(c + m, x + m, m);
  if (h < 2.0) return vec3(x + m, c + m, m);
  if (h < 3.0) return vec3(m, c + m, x + m);
  if (h < 4.0) return vec3(m, x + m, c + m);
  if (h < 5.0) return vec3(x + m, m, c + m);
  return vec3(c + m, m, x + m);
}

vec3 orientationColor(vec3 vectorValue) {
  float magnitude = length(vectorValue);
  if (magnitude <= 1e-30) {
    return vec3(0.6, 0.6, 0.6);
  }

  vec3 normalized = vectorValue / magnitude;
  float hueRadians = atan(normalized.y, normalized.x);
  float saturation = clamp(length(normalized.xy), 0.0, 1.0);
  float lightness = clamp(normalized.z * 0.5 + 0.5, 0.0, 1.0);
  return orientationHslToRgb(hueRadians, saturation, lightness);
}

void main() {
  #include <clipping_planes_fragment>
  vec3 base = orientationColor(vVectorValue);
  vec3 n = normalize(vNormalView) * (gl_FrontFacing ? 1.0 : -1.0);
  float ndl = clamp(dot(n, normalize(vec3(0.35, 0.55, 0.75))) * 0.5 + 0.5, 0.0, 1.0);
  vec3 color = base * mix(1.0, 0.55 + 0.75 * ndl, fmShadeStrength);
  gl_FragColor = vec4(color, fmOpacity);
}
`;
