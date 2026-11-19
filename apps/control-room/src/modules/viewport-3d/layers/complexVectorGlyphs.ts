import {
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  ShaderMaterial,
  type BufferGeometry,
  type Side,
} from "three";

import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";
import {
  isLivePhaseUniform,
  type LivePhaseUniform,
} from "@/kernel/visualization/livePhaseUniform";
import {
  floquetPhaseAdapter,
  phasorAdapter,
} from "@/shared/domain/analysis/phasorConventionAdapter";

import type { ScalarRange } from "../viewport3dFieldMapping";
import {
  complexRepresentationId,
  scalarPaletteGlsl,
  scalarPaletteId,
  VIEWPORT_3D_ORIENTATION_COLOR_GLSL,
} from "../viewport3dScalarSurfaceShader";
import { normalizeViewport3DVectorColorMode } from "../viewport3dVectorColoring";

/**
 * Vector glyphs for a complex (phasor) field whose phase is applied on the GPU.
 *
 * Every per-glyph array is independent of the display phase: anchors, the
 * real and imaginary parts and the cycle envelope. The vertex shader projects
 * v(theta) = Re cos(theta) - Im sin(theta) and orients the fixed-length glyph
 * along it, so phase animation changes one uniform and nothing else.
 */
export type ComplexVectorGlyphRepresentation =
  | "phase_rotated_real"
  | "real"
  | "imag";

export type ComplexVectorGlyphAnchorMode = "center" | "tail";

export interface Viewport3DComplexVectorGlyphs {
  /** Glyph anchor: segment midpoint for "center", glyph tail for "tail". */
  readonly anchors: Float32Array;
  /** Physical sample positions, before any glyph display offset. */
  readonly phasePositions: Float32Array;
  readonly anchorMode: ComplexVectorGlyphAnchorMode;
  readonly buildKey: string;
  /** Real part per glyph, already multiplied by the amplitude scale. */
  readonly complexReal: Float32Array;
  /** Imaginary part per glyph, already multiplied by the amplitude scale. */
  readonly complexImag: Float32Array;
  readonly count: number;
  /** Largest per-glyph hypot(Re_c, Im_c) for each component over the cycle. */
  readonly componentEnvelopeMax: readonly [number, number, number];
  /** World-space glyph length; independent of the field magnitude. */
  readonly glyphLength: number;
  /** Largest per-glyph sqrt(|Re|^2 + |Im|^2), the magnitude color ceiling. */
  readonly magnitudeEnvelopeMax: number;
  readonly representation: ComplexVectorGlyphRepresentation;
}

const SEGMENT_STRIDE = 7;

const glyphsBySegments = new WeakMap<
  Float32Array,
  WeakMap<DecodedComplexFieldVector, Map<string, Viewport3DComplexVectorGlyphs | null>>
>();

/**
 * Re-expresses an already sampled, phase-independent segment build as complex
 * glyphs. `sampleIndices[i]` is the complex-field point drawn by segment i.
 */
export function buildComplexVectorGlyphsFromSegments({
  anchorMode,
  buildKey,
  complexField,
  nodeIndices,
  positions,
  representation = "phase_rotated_real",
  sampleIndices,
  segments,
}: {
  anchorMode: ComplexVectorGlyphAnchorMode;
  buildKey: string;
  complexField: DecodedComplexFieldVector;
  nodeIndices: ArrayLike<number>;
  positions: ArrayLike<number>;
  representation?: ComplexVectorGlyphRepresentation;
  sampleIndices: ArrayLike<number> | null | undefined;
  segments: Float32Array | null | undefined;
}): Viewport3DComplexVectorGlyphs | null {
  if (!segments || !sampleIndices) return null;
  let bySegments = glyphsBySegments.get(segments);
  if (!bySegments) {
    bySegments = new WeakMap();
    glyphsBySegments.set(segments, bySegments);
  }
  let byField = bySegments.get(complexField);
  if (!byField) {
    byField = new Map();
    bySegments.set(complexField, byField);
  }
  const cacheKey = `${anchorMode}:${representation}:${buildKey}`;
  if (byField.has(cacheKey)) return byField.get(cacheKey) ?? null;
  const glyphs = buildGlyphsFromSegments({
    anchorMode,
    buildKey,
    complexField,
    nodeIndices,
    positions,
    representation,
    sampleIndices,
    segments,
  });
  byField.set(cacheKey, glyphs);
  return glyphs;
}

function buildGlyphsFromSegments({
  anchorMode,
  buildKey,
  complexField,
  nodeIndices,
  positions,
  representation,
  sampleIndices,
  segments,
}: {
  anchorMode: ComplexVectorGlyphAnchorMode;
  buildKey: string;
  complexField: DecodedComplexFieldVector;
  nodeIndices: ArrayLike<number>;
  positions: ArrayLike<number>;
  representation: ComplexVectorGlyphRepresentation;
  sampleIndices: ArrayLike<number>;
  segments: Float32Array;
}): Viewport3DComplexVectorGlyphs | null {
  if (complexField.componentCount !== 3 || segments.length % SEGMENT_STRIDE !== 0) {
    return null;
  }
  const segmentCount = segments.length / SEGMENT_STRIDE;
  if (segmentCount === 0 || sampleIndices.length < segmentCount || nodeIndices.length < segmentCount) {
    return null;
  }
  const anchors = new Float32Array(segmentCount * 3);
  const phasePositions = new Float32Array(segmentCount * 3);
  const complexReal = new Float32Array(segmentCount * 3);
  const complexImag = new Float32Array(segmentCount * 3);
  let glyphLength = 0;
  for (let glyph = 0; glyph < segmentCount; glyph += 1) {
    const source = glyph * SEGMENT_STRIDE;
    const target = glyph * 3;
    const sx = segments[source]!;
    const sy = segments[source + 1]!;
    const sz = segments[source + 2]!;
    const ex = segments[source + 3]!;
    const ey = segments[source + 4]!;
    const ez = segments[source + 5]!;
    if (glyphLength === 0) glyphLength = Math.hypot(ex - sx, ey - sy, ez - sz);
    anchors[target] = anchorMode === "tail" ? sx : (sx + ex) / 2;
    anchors[target + 1] = anchorMode === "tail" ? sy : (sy + ey) / 2;
    anchors[target + 2] = anchorMode === "tail" ? sz : (sz + ez) / 2;
    const point = sampleIndices[glyph];
    if (
      point === undefined ||
      !Number.isInteger(point) ||
      point < 0 ||
      point >= complexField.pointCount
    ) {
      return null;
    }
    const node = nodeIndices[glyph]!;
    if (!Number.isInteger(node) || node < 0 || node * 3 + 2 >= positions.length) {
      return null;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      phasePositions[target + axis] = positions[node * 3 + axis]!;
    }
    copyComplexPoint(complexField, point, 1, complexReal, complexImag, target);
  }
  if (!(glyphLength > 0)) return null;
  return finalizeGlyphs({
    anchorMode,
    anchors,
    buildKey,
    complexImag,
    complexReal,
    count: segmentCount,
    glyphLength,
    phasePositions,
    representation,
  });
}

/**
 * Builds glyphs centered on explicit topology nodes, used by mode-composition
 * layers whose field carries explicit node indices.
 */
export function buildComplexVectorGlyphsAtNodes({
  amplitudeScale,
  buildKey,
  complexField,
  glyphLength,
  nodeIndices,
  pointIndices,
  positions,
  representation,
}: {
  amplitudeScale: number;
  buildKey: string;
  complexField: DecodedComplexFieldVector;
  glyphLength: number;
  nodeIndices: ArrayLike<number>;
  pointIndices: ArrayLike<number>;
  positions: ArrayLike<number>;
  representation: ComplexVectorGlyphRepresentation;
}): Viewport3DComplexVectorGlyphs | null {
  const count = Math.min(nodeIndices.length, pointIndices.length);
  if (
    count === 0 ||
    complexField.componentCount !== 3 ||
    !(glyphLength > 0) ||
    !Number.isFinite(amplitudeScale)
  ) {
    return null;
  }
  const anchors = new Float32Array(count * 3);
  const complexReal = new Float32Array(count * 3);
  const complexImag = new Float32Array(count * 3);
  for (let glyph = 0; glyph < count; glyph += 1) {
    const node = nodeIndices[glyph]!;
    const target = glyph * 3;
    anchors[target] = positions[node * 3] ?? 0;
    anchors[target + 1] = positions[node * 3 + 1] ?? 0;
    anchors[target + 2] = positions[node * 3 + 2] ?? 0;
    copyComplexPoint(
      complexField,
      pointIndices[glyph]!,
      amplitudeScale,
      complexReal,
      complexImag,
      target,
    );
  }
  return finalizeGlyphs({
    anchorMode: "center",
    anchors,
    phasePositions: anchors,
    buildKey,
    complexImag,
    complexReal,
    count,
    glyphLength,
    representation,
  });
}

function copyComplexPoint(
  field: DecodedComplexFieldVector,
  point: number,
  amplitudeScale: number,
  real: Float32Array,
  imag: Float32Array,
  target: number,
): void {
  for (let component = 0; component < 3; component += 1) {
    const source = (point * 3 + component) * 2;
    const re = field.values[source] ?? 0;
    const im = field.values[source + 1] ?? 0;
    real[target + component] = Number.isFinite(re) ? re * amplitudeScale : 0;
    imag[target + component] = Number.isFinite(im) ? im * amplitudeScale : 0;
  }
}

function finalizeGlyphs(
  glyphs: Omit<Viewport3DComplexVectorGlyphs, "componentEnvelopeMax" | "magnitudeEnvelopeMax">,
): Viewport3DComplexVectorGlyphs {
  const componentEnvelopeMax: [number, number, number] = [0, 0, 0];
  let magnitudeEnvelopeMax = 0;
  for (let glyph = 0; glyph < glyphs.count; glyph += 1) {
    let squared = 0;
    for (let component = 0; component < 3; component += 1) {
      const offset = glyph * 3 + component;
      const envelope = envelopeComponent(
        glyphs.representation,
        glyphs.complexReal[offset]!,
        glyphs.complexImag[offset]!,
      );
      componentEnvelopeMax[component] = Math.max(
        componentEnvelopeMax[component],
        envelope,
      );
      squared += envelope * envelope;
    }
    magnitudeEnvelopeMax = Math.max(magnitudeEnvelopeMax, Math.sqrt(squared));
  }
  return { ...glyphs, componentEnvelopeMax, magnitudeEnvelopeMax };
}

function envelopeComponent(
  representation: ComplexVectorGlyphRepresentation,
  real: number,
  imag: number,
): number {
  if (representation === "real") return Math.abs(real);
  if (representation === "imag") return Math.abs(imag);
  return Math.hypot(real, imag);
}

/** Phase-independent color range for a glyph color mode, in field units. */
export function complexVectorGlyphColorRange(
  glyphs: Viewport3DComplexVectorGlyphs,
  colorMode: string | null | undefined,
): ScalarRange {
  const mode = normalizeViewport3DVectorColorMode(colorMode);
  const componentIndex = mode === "x" ? 0 : mode === "y" ? 1 : mode === "z" ? 2 : null;
  if (componentIndex !== null) {
    const extent = Math.max(glyphs.componentEnvelopeMax[componentIndex], 1e-30);
    return { max: extent, min: -extent };
  }
  return { max: Math.max(glyphs.magnitudeEnvelopeMax, 1e-30), min: 0 };
}

/**
 * CPU mirror of the vertex-shader projection. Used by tests and diagnostics;
 * the renderer never calls it per frame.
 */
export function projectComplexVectorGlyph(
  glyphs: Viewport3DComplexVectorGlyphs,
  index: number,
  thetaRad: number,
): [number, number, number] {
  const offset = index * 3;
  const cosine = Math.cos(thetaRad);
  const sine = Math.sin(thetaRad);
  const result: [number, number, number] = [0, 0, 0];
  for (let component = 0; component < 3; component += 1) {
    const real = glyphs.complexReal[offset + component]!;
    const imag = glyphs.complexImag[offset + component]!;
    result[component] =
      glyphs.representation === "real"
        ? real
        : glyphs.representation === "imag"
          ? imag
          : real * cosine - imag * sine;
  }
  return result;
}

export const COMPLEX_VECTOR_GLYPH_ANCHOR_ATTRIBUTE = "fmGlyphAnchor";
export const COMPLEX_VECTOR_GLYPH_PHASE_POSITION_ATTRIBUTE = "fmGlyphPhasePosition";
export const COMPLEX_VECTOR_GLYPH_REAL_ATTRIBUTE = "fmGlyphReal";
export const COMPLEX_VECTOR_GLYPH_IMAG_ATTRIBUTE = "fmGlyphImag";
const COMPLEX_VECTOR_GLYPH_PART_ATTRIBUTE = "fmGlyphPart";

export type ComplexVectorGlyphPart = "head" | "shaft";

/**
 * Instanced geometry sharing one unit cylinder or cone. The per-glyph
 * attributes are uploaded once per build; animation never rewrites them.
 */
export function createComplexVectorGlyphGeometry(
  glyphs: Viewport3DComplexVectorGlyphs,
  part: ComplexVectorGlyphPart,
): InstancedBufferGeometry {
  const base: BufferGeometry =
    part === "head" ? new ConeGeometry(1, 1, 12, 1) : new CylinderGeometry(1, 1, 1, 12, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(base.getIndex());
  geometry.setAttribute("position", base.getAttribute("position"));
  geometry.setAttribute("normal", base.getAttribute("normal"));
  const vertexCount = base.getAttribute("position").count;
  geometry.setAttribute(
    COMPLEX_VECTOR_GLYPH_PART_ATTRIBUTE,
    new BufferAttribute(new Float32Array(vertexCount).fill(part === "head" ? 1 : 0), 1),
  );
  base.dispose();
  const anchors = new InstancedBufferAttribute(glyphs.anchors, 3);
  geometry.setAttribute(COMPLEX_VECTOR_GLYPH_ANCHOR_ATTRIBUTE, anchors);
  geometry.setAttribute(
    COMPLEX_VECTOR_GLYPH_PHASE_POSITION_ATTRIBUTE,
    glyphs.phasePositions === glyphs.anchors
      ? anchors
      : new InstancedBufferAttribute(glyphs.phasePositions, 3),
  );
  geometry.setAttribute(
    COMPLEX_VECTOR_GLYPH_REAL_ATTRIBUTE,
    new InstancedBufferAttribute(glyphs.complexReal, 3),
  );
  geometry.setAttribute(
    COMPLEX_VECTOR_GLYPH_IMAG_ATTRIBUTE,
    new InstancedBufferAttribute(glyphs.complexImag, 3),
  );
  geometry.instanceCount = glyphs.count;
  return geometry;
}

export interface ComplexVectorGlyphMaterialOptions {
  cellOrigin?: readonly [number, number, number] | null;
  colorMode: string;
  colorRange: ScalarRange;
  floquetSpatialConvention?: string | null;
  headLengthRatio: number;
  headRadiusRatio: number;
  monoColor: string;
  opacity: number;
  palette: string | null | undefined;
  /** Shared live phase cell, or a static phase for non-animated glyphs. */
  phase: LivePhaseUniform | number;
  phasorConvention?: string | null;
  shaftRadiusRatio: number;
  wavevectorKf?: readonly [number, number, number] | null;
}

export const DEFAULT_COMPLEX_VECTOR_GLYPH_HEAD_LENGTH_RATIO = 0.28;

/**
 * Creates the glyph program with neutral uniforms; callers apply the glyph set
 * and style with `updateComplexVectorGlyphMaterial` before the first draw.
 */
export function createComplexVectorGlyphMaterial({
  depthTest,
  depthWrite,
  side,
}: {
  depthTest: boolean;
  depthWrite: boolean;
  side: Side;
}): ShaderMaterial {
  const material = new ShaderMaterial({
    clipping: true,
    depthTest,
    depthWrite,
    fragmentShader: COMPLEX_VECTOR_GLYPH_FRAGMENT_SHADER,
    name: "FullmagComplexVectorGlyphMaterial",
    side,
    transparent: false,
    uniforms: {
      fmAnchorOffset: { value: 0.5 },
      fmCellOrigin: { value: [0, 0, 0] },
      fmColorModeId: { value: 1 },
      fmFloquetActive: { value: 0 },
      fmGlyphLength: { value: 0 },
      fmHeadLengthRatio: { value: DEFAULT_COMPLEX_VECTOR_GLYPH_HEAD_LENGTH_RATIO },
      fmHeadRadiusRatio: { value: 0.1 },
      fmMonoColor: { value: new Color() },
      fmOpacity: { value: 1 },
      fmPaletteId: { value: 0 },
      fmPhaseRad: { value: 0 },
      fmRepresentationId: { value: 0 },
      fmScalarMax: { value: 1 },
      fmScalarMin: { value: 0 },
      fmShaftRadiusRatio: { value: 0.035 },
      fmSpatialPhaseSign: { value: -1 },
      fmTemporalPhaseSign: { value: 1 },
      fmWavevectorKf: { value: [0, 0, 0] },
    },
    vertexShader: COMPLEX_VECTOR_GLYPH_VERTEX_SHADER,
  });
  material.toneMapped = false;
  return material;
}

/** Applies glyph-set and style changes; never called for phase changes. */
export function updateComplexVectorGlyphMaterial(
  material: ShaderMaterial,
  glyphs: Viewport3DComplexVectorGlyphs,
  options: ComplexVectorGlyphMaterialOptions,
): void {
  const uniforms = material.uniforms;
  bindComplexVectorGlyphPhase(material, options.phase);
  uniforms.fmAnchorOffset!.value = glyphs.anchorMode === "tail" ? 0 : 0.5;
  uniforms.fmGlyphLength!.value = glyphs.glyphLength;
  uniforms.fmRepresentationId!.value = complexRepresentationId(glyphs.representation);
  uniforms.fmColorModeId!.value = complexVectorGlyphColorModeId(options.colorMode);
  uniforms.fmPaletteId!.value = Math.max(0, scalarPaletteId(options.palette ?? "viridis"));
  uniforms.fmScalarMin!.value = options.colorRange.min;
  uniforms.fmScalarMax!.value = options.colorRange.max;
  (uniforms.fmMonoColor!.value as Color).set(options.monoColor);
  uniforms.fmOpacity!.value = options.opacity;
  uniforms.fmHeadLengthRatio!.value = options.headLengthRatio;
  uniforms.fmHeadRadiusRatio!.value = options.headRadiusRatio;
  uniforms.fmShaftRadiusRatio!.value = options.shaftRadiusRatio;
  uniforms.fmTemporalPhaseSign!.value = options.phasorConvention
    ? phasorAdapter(options.phasorConvention as Parameters<typeof phasorAdapter>[0])
        .phaseAnimationDirection
    : 1;
  uniforms.fmSpatialPhaseSign!.value = options.floquetSpatialConvention
    ? floquetPhaseAdapter(
        options.floquetSpatialConvention as Parameters<typeof floquetPhaseAdapter>[0],
      ).spatialPhaseSign
    : -1;
  uniforms.fmFloquetActive!.value = options.wavevectorKf ? 1 : 0;
  uniforms.fmWavevectorKf!.value = options.wavevectorKf ? [...options.wavevectorKf] : [0, 0, 0];
  uniforms.fmCellOrigin!.value = options.cellOrigin ? [...options.cellOrigin] : [0, 0, 0];
  const transparent = options.opacity < 0.99;
  if (material.transparent !== transparent) {
    material.transparent = transparent;
    material.needsUpdate = true;
  }
}

function bindComplexVectorGlyphPhase(
  material: ShaderMaterial,
  phase: LivePhaseUniform | number,
): void {
  if (typeof phase !== "number") {
    if (material.uniforms.fmPhaseRad !== phase) material.uniforms.fmPhaseRad = phase;
    return;
  }
  const current = material.uniforms.fmPhaseRad;
  const staticPhaseRad = Number.isFinite(phase) ? phase : 0;
  if (!current || isLivePhaseUniform(current)) {
    material.uniforms.fmPhaseRad = { value: staticPhaseRad };
    return;
  }
  current.value = staticPhaseRad;
}

export function complexVectorGlyphColorModeId(colorMode: string | null | undefined): number {
  switch (normalizeViewport3DVectorColorMode(colorMode)) {
    case "monochrome":
      return -1;
    case "magnitude":
      return 0;
    case "orientation":
      return 1;
    case "x":
      return 2;
    case "y":
      return 3;
    case "z":
      return 4;
  }
}

const COMPLEX_VECTOR_GLYPH_VERTEX_SHADER = `
#include <clipping_planes_pars_vertex>

attribute vec3 ${COMPLEX_VECTOR_GLYPH_ANCHOR_ATTRIBUTE};
attribute vec3 ${COMPLEX_VECTOR_GLYPH_PHASE_POSITION_ATTRIBUTE};
attribute vec3 ${COMPLEX_VECTOR_GLYPH_REAL_ATTRIBUTE};
attribute vec3 ${COMPLEX_VECTOR_GLYPH_IMAG_ATTRIBUTE};
attribute float ${COMPLEX_VECTOR_GLYPH_PART_ATTRIBUTE};
uniform float fmPhaseRad;
uniform float fmTemporalPhaseSign;
uniform float fmSpatialPhaseSign;
uniform int fmFloquetActive;
uniform vec3 fmWavevectorKf;
uniform vec3 fmCellOrigin;
uniform int fmRepresentationId;
uniform float fmGlyphLength;
uniform float fmAnchorOffset;
uniform float fmHeadLengthRatio;
uniform float fmHeadRadiusRatio;
uniform float fmShaftRadiusRatio;
varying vec3 vGlyphVector;

const float FM_GLYPH_PI = 3.141592653589793;
const float FM_GLYPH_TWO_PI = 6.283185307179586;

vec3 projectGlyph(vec3 complexReal, vec3 complexImag, float theta) {
  if (fmRepresentationId == 1) return complexReal;
  if (fmRepresentationId == 2) return complexImag;
  return complexReal * cos(theta) - complexImag * sin(theta);
}

void main() {
  float theta = fmTemporalPhaseSign * fmPhaseRad;
  if (fmFloquetActive == 1) {
    theta += fmSpatialPhaseSign * dot(fmWavevectorKf, ${COMPLEX_VECTOR_GLYPH_PHASE_POSITION_ATTRIBUTE} - fmCellOrigin);
    theta = mod(theta + FM_GLYPH_PI, FM_GLYPH_TWO_PI) - FM_GLYPH_PI;
  }
  vec3 value = projectGlyph(
    ${COMPLEX_VECTOR_GLYPH_REAL_ATTRIBUTE},
    ${COMPLEX_VECTOR_GLYPH_IMAG_ATTRIBUTE},
    theta
  );
  vGlyphVector = value;
  float magnitude = length(value);
  // A glyph whose instantaneous vector vanishes collapses to its anchor, as a
  // zero-magnitude sample is skipped by the CPU segment builder.
  bool visible = magnitude > 1e-30;
  vec3 direction = visible ? value / magnitude : vec3(0.0, 1.0, 0.0);
  vec3 helper = abs(direction.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  // Right-handed frame (tangent, direction, bitangent) keeps the unit
  // geometry's winding, so FrontSide culling stays correct.
  vec3 tangent = normalize(cross(helper, direction));
  vec3 bitangent = cross(tangent, direction);
  float glyphLength = visible ? fmGlyphLength : 0.0;
  float headLength = glyphLength * fmHeadLengthRatio;
  float shaftLength = max(glyphLength - headLength, 0.0);
  bool head = ${COMPLEX_VECTOR_GLYPH_PART_ATTRIBUTE} > 0.5;
  float partLength = head ? headLength : shaftLength;
  float partStart = head ? shaftLength : 0.0;
  float radius = glyphLength * (head ? fmHeadRadiusRatio : fmShaftRadiusRatio);
  vec3 tail = ${COMPLEX_VECTOR_GLYPH_ANCHOR_ATTRIBUTE} - direction * (glyphLength * fmAnchorOffset);
  vec3 world = tail
    + direction * (partStart + (position.y + 0.5) * partLength)
    + tangent * (position.x * radius)
    + bitangent * (position.z * radius);
  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const COMPLEX_VECTOR_GLYPH_FRAGMENT_SHADER = `
precision highp float;

#include <clipping_planes_pars_fragment>

uniform int fmColorModeId;
uniform int fmPaletteId;
uniform float fmScalarMin;
uniform float fmScalarMax;
uniform vec3 fmMonoColor;
uniform float fmOpacity;
varying vec3 vGlyphVector;

${VIEWPORT_3D_ORIENTATION_COLOR_GLSL}

vec3 paletteColor(float t) {
  ${scalarPaletteGlsl()}
  return vec3(0.0);
}

void main() {
  #include <clipping_planes_fragment>

  vec3 color;
  if (fmColorModeId < 0) {
    color = fmMonoColor;
  } else if (fmColorModeId == 1) {
    color = srgbToLinearVec3(orientationColor(vGlyphVector));
  } else {
    float value = fmColorModeId == 2
      ? vGlyphVector.x
      : fmColorModeId == 3
        ? vGlyphVector.y
        : fmColorModeId == 4
          ? vGlyphVector.z
          : length(vGlyphVector);
    float span = fmScalarMax - fmScalarMin;
    float t = span > 0.0 ? clamp((value - fmScalarMin) / span, 0.0, 1.0) : 0.5;
    color = srgbToLinearVec3(paletteColor(t));
  }
  gl_FragColor = vec4(color, fmOpacity);
  #include <colorspace_fragment>
}
`;
