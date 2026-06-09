import {
  BufferAttribute,
  BufferGeometry,
  ShaderMaterial,
  type Side,
} from "three";

import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import {
  normalizeViewport3DColorPalette,
  normalizeViewport3DVectorColorMode,
} from "./viewport3dVectorColoring";

export const VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE = "fmScalarValue";
export const VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE = "fmVectorValue";

export interface Viewport3DScalarSurfaceShaderOptions {
  depthTest: boolean;
  depthWrite: boolean;
  opacity: number;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  side: Side;
  toneMapped?: boolean;
  transparent: boolean;
}

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
  return Boolean(
    (hasScalarValues || hasVectorValues) &&
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

  if (!hasScalarValues && !hasVectorValues) {
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

  return true;
}

export function createScalarSurfaceShaderMaterial(
  buffer: ScalarColorBuffer,
  options: Viewport3DScalarSurfaceShaderOptions,
): ShaderMaterial {
  const colorModeId = shaderColorModeId(buffer.colorMode);
  const orientationMode = colorModeId === 1;
  const material = new ShaderMaterial({
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
      fmOpacity: { value: options.opacity },
      fmPaletteId: { value: scalarPaletteId(buffer.colorPalette) },
      fmScalarMax: { value: buffer.range.max },
      fmScalarMin: { value: buffer.range.min },
    },
    vertexShader: orientationMode
      ? ORIENTATION_SURFACE_VERTEX_SHADER
      : SCALAR_SURFACE_VERTEX_SHADER,
  });
  material.toneMapped = options.toneMapped ?? false;
  return material;
}

export function updateScalarSurfaceShaderMaterial(
  material: ShaderMaterial,
  buffer: ScalarColorBuffer,
  opacity: number,
): void {
  const nextColorModeId = shaderColorModeId(buffer.colorMode);
  const orientationMode = nextColorModeId === 1;
  const nextVertexShader = orientationMode
    ? ORIENTATION_SURFACE_VERTEX_SHADER
    : SCALAR_SURFACE_VERTEX_SHADER;
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

  material.uniforms.fmColorModeId.value = nextColorModeId;
  material.uniforms.fmOpacity.value = opacity;
  material.uniforms.fmPaletteId.value = scalarPaletteId(buffer.colorPalette);
  material.uniforms.fmScalarMax.value = buffer.range.max;
  material.uniforms.fmScalarMin.value = buffer.range.min;
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
}

function shaderColorModeId(mode: string | null | undefined): number {
  return normalizeViewport3DVectorColorMode(mode, "magnitude") === "orientation"
    ? 1
    : 0;
}

function scalarPaletteId(palette: string | null | undefined): number {
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

void main() {
  vScalarValue = ${VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ORIENTATION_SURFACE_VERTEX_SHADER = `
attribute vec3 ${VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE};
varying vec3 vVectorValue;

void main() {
  vVectorValue = ${VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SCALAR_SURFACE_FRAGMENT_SHADER = `
precision highp float;

uniform float fmOpacity;
uniform int fmPaletteId;
uniform float fmScalarMin;
uniform float fmScalarMax;
varying float vScalarValue;

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
  return mixStops4(t, vec3(0.267, 0.004, 0.329), vec3(0.192, 0.408, 0.557), vec3(0.208, 0.718, 0.475), vec3(0.992, 0.906, 0.145));
}

void main() {
  float span = max(fmScalarMax - fmScalarMin, 1e-12);
  float t = clamp((vScalarValue - fmScalarMin) / span, 0.0, 1.0);
  gl_FragColor = vec4(paletteColor(t), fmOpacity);
}
`;

const ORIENTATION_SURFACE_FRAGMENT_SHADER = `
precision highp float;

uniform float fmOpacity;
varying vec3 vVectorValue;

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
  gl_FragColor = vec4(orientationColor(vVectorValue), fmOpacity);
}
`;
