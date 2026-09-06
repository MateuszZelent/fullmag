import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  ShaderMaterial,
} from "three";

import { normalizeScalarColorPalette } from "@/shared/visualization/scalarColorPalette";

export const FEM_SCALAR_VALUE_ATTRIBUTE = "fmScalarValue";
export const FEM_VECTOR_VALUE_ATTRIBUTE = "fmVectorValue";

export interface FemCutSurfaceInput {
  bounds: readonly [number, number, number, number];
  colormap?: string;
  opacity?: number;
  originOffset?: readonly [number, number];
  range: { max: number; min: number };
  scalarValues: Float32Array;
  vectorMode?: "magnitude" | "orientation" | "x" | "y" | "z" | "monochrome";
  vectorValues?: Float32Array;
  verticesUv: Float32Array;
}

export function triangulateCutPolygons(
  polygonOffsets: Uint32Array,
  polygonVertices: Float32Array,
  parentElementIds?: Uint32Array,
  vertexScalarEvaluator?: (
    vertexIndex: number,
    u: number,
    v: number,
    parentElementId: number,
  ) => number,
  vertexVectorEvaluator?: (
    vertexIndex: number,
    u: number,
    v: number,
    parentElementId: number,
  ) => [number, number, number],
): {
  scalarValues: Float32Array;
  triangleCount: number;
  vectorValues?: Float32Array;
  verticesUv: Float32Array;
} {
  const polygonCount = polygonOffsets.length - 1;
  let totalTriangles = 0;
  for (let i = 0; i < polygonCount; i++) {
    const start = polygonOffsets[i]!;
    const end = polygonOffsets[i + 1]!;
    const count = end - start;
    if (count >= 3) {
      totalTriangles += count - 2;
    }
  }

  const verticesUv = new Float32Array(totalTriangles * 3 * 2);
  const scalarValues = new Float32Array(totalTriangles * 3);
  const hasVectors = vertexVectorEvaluator !== undefined;
  const vectorValues = hasVectors
    ? new Float32Array(totalTriangles * 3 * 3)
    : undefined;

  let vertexOffset = 0;
  let scalarOffset = 0;
  let vectorOffset = 0;

  for (let polyIdx = 0; polyIdx < polygonCount; polyIdx++) {
    const start = polygonOffsets[polyIdx]!;
    const end = polygonOffsets[polyIdx + 1]!;
    const k = end - start;
    if (k < 3) continue;

    const parentElemId = parentElementIds ? parentElementIds[polyIdx]! : polyIdx;

    // Fan triangulation of convex cut polygon:
    // (0, j, j + 1) for j = 1 .. k - 2.
    // For affine fields on planar cuts of tetrahedra, this preserves exact linearity.
    for (let j = 1; j < k - 1; j++) {
      const idxs = [start, start + j, start + j + 1];
      for (const globalVertIdx of idxs) {
        const u = polygonVertices[globalVertIdx * 2]!;
        const v = polygonVertices[globalVertIdx * 2 + 1]!;

        verticesUv[vertexOffset++] = u;
        verticesUv[vertexOffset++] = v;

        const s = vertexScalarEvaluator
          ? vertexScalarEvaluator(globalVertIdx, u, v, parentElemId)
          : 0;
        scalarValues[scalarOffset++] = s;

        if (hasVectors && vectorValues && vertexVectorEvaluator) {
          const vec = vertexVectorEvaluator(globalVertIdx, u, v, parentElemId);
          vectorValues[vectorOffset++] = vec[0];
          vectorValues[vectorOffset++] = vec[1];
          vectorValues[vectorOffset++] = vec[2];
        }
      }
    }
  }

  return {
    scalarValues,
    triangleCount: totalTriangles,
    vectorValues,
    verticesUv,
  };
}

export function createFemCutSurfaceGeometry(input: {
  originOffset?: readonly [number, number];
  scalarValues: Float32Array;
  vectorValues?: Float32Array;
  verticesUv: Float32Array;
}): BufferGeometry {
  const vertexCount = Math.floor(input.verticesUv.length / 2);
  const geometry = new BufferGeometry();

  const [originU, originV] = input.originOffset ?? [0, 0];
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = input.verticesUv[i * 2]! - originU;
    positions[i * 3 + 1] = input.verticesUv[i * 2 + 1]! - originV;
    positions[i * 3 + 2] = 0;
  }

  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute(
    FEM_SCALAR_VALUE_ATTRIBUTE,
    new BufferAttribute(input.scalarValues, 1),
  );

  if (input.vectorValues && input.vectorValues.length === vertexCount * 3) {
    geometry.setAttribute(
      FEM_VECTOR_VALUE_ATTRIBUTE,
      new BufferAttribute(input.vectorValues, 3),
    );
  }

  return geometry;
}

export function updateFemCutSurfaceGeometry(
  geometry: BufferGeometry,
  input: {
    originOffset?: readonly [number, number];
    scalarValues: Float32Array;
    vectorValues?: Float32Array;
    verticesUv: Float32Array;
  },
): void {
  const vertexCount = Math.floor(input.verticesUv.length / 2);
  const [originU, originV] = input.originOffset ?? [0, 0];

  const posAttr = geometry.getAttribute("position");
  if (posAttr && posAttr.count === vertexCount) {
    const array = posAttr.array as Float32Array;
    for (let i = 0; i < vertexCount; i++) {
      array[i * 3] = input.verticesUv[i * 2]! - originU;
      array[i * 3 + 1] = input.verticesUv[i * 2 + 1]! - originV;
      array[i * 3 + 2] = 0;
    }
    posAttr.needsUpdate = true;
  } else {
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3] = input.verticesUv[i * 2]! - originU;
      positions[i * 3 + 1] = input.verticesUv[i * 2 + 1]! - originV;
      positions[i * 3 + 2] = 0;
    }
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
  }

  const scalarAttr = geometry.getAttribute(FEM_SCALAR_VALUE_ATTRIBUTE);
  if (scalarAttr && scalarAttr.count === vertexCount) {
    (scalarAttr.array as Float32Array).set(input.scalarValues);
    scalarAttr.needsUpdate = true;
  } else {
    geometry.setAttribute(
      FEM_SCALAR_VALUE_ATTRIBUTE,
      new BufferAttribute(input.scalarValues, 1),
    );
  }

  if (input.vectorValues && input.vectorValues.length === vertexCount * 3) {
    const vecAttr = geometry.getAttribute(FEM_VECTOR_VALUE_ATTRIBUTE);
    if (vecAttr && vecAttr.count === vertexCount) {
      (vecAttr.array as Float32Array).set(input.vectorValues);
      vecAttr.needsUpdate = true;
    } else {
      geometry.setAttribute(
        FEM_VECTOR_VALUE_ATTRIBUTE,
        new BufferAttribute(input.vectorValues, 3),
      );
    }
  } else if (geometry.hasAttribute(FEM_VECTOR_VALUE_ATTRIBUTE)) {
    geometry.deleteAttribute(FEM_VECTOR_VALUE_ATTRIBUTE);
  }
}

export function paletteIdFromName(name: string | null | undefined): number {
  if (!name) return 0;
  const normalized = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "grayscale") return 6;
  if (normalized === "twilight") return 5;
  switch (normalizeScalarColorPalette(normalized)) {
    case "coolwarm":
      return 1;
    case "inferno":
      return 2;
    case "jet":
      return 3;
    case "magma":
      return 4;
    case "viridis":
    default:
      return 0;
  }
}

export function vectorModeId(mode: string | null | undefined): number {
  switch (mode) {
    case "orientation":
      return 1;
    case "x":
      return 2;
    case "y":
      return 3;
    case "z":
      return 4;
    case "magnitude":
      return 5;
    default:
      return 0; // standard scalar
  }
}

const FEM_CUT_SURFACE_VERTEX_SHADER = `
attribute float ${FEM_SCALAR_VALUE_ATTRIBUTE};
attribute vec3 ${FEM_VECTOR_VALUE_ATTRIBUTE};
varying float vScalarValue;
varying vec3 vVectorValue;

void main() {
  vScalarValue = ${FEM_SCALAR_VALUE_ATTRIBUTE};
  vVectorValue = ${FEM_VECTOR_VALUE_ATTRIBUTE};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FEM_CUT_SURFACE_FRAGMENT_SHADER = `
precision highp float;

uniform float fmOpacity;
uniform int fmPaletteId;
uniform int fmColorModeId;
uniform float fmScalarMin;
uniform float fmScalarMax;
varying float vScalarValue;
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

vec3 mixStops3(float t, vec3 a, vec3 b, vec3 c) {
  if (t < 0.5) return mix(a, b, t * 2.0);
  return mix(b, c, (t - 0.5) * 2.0);
}

vec3 mixStops4(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  if (t < 0.3333333) return mix(a, b, t * 3.0);
  if (t < 0.6666667) return mix(b, c, (t - 0.3333333) * 3.0);
  return mix(c, d, (t - 0.6666667) * 3.0);
}

vec3 mixStops5(float t, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  if (t < 0.25) return mix(a, b, t * 4.0);
  if (t < 0.5) return mix(b, c, (t - 0.25) * 4.0);
  if (t < 0.75) return mix(c, d, (t - 0.5) * 4.0);
  return mix(d, e, (t - 0.75) * 4.0);
}

vec3 paletteColor(float t, int paletteId) {
  if (paletteId == 1) {
    // coolwarm
    return mixStops3(t, vec3(0.231, 0.298, 0.753), vec3(0.867, 0.867, 0.867), vec3(0.706, 0.016, 0.149));
  }
  if (paletteId == 2) {
    // inferno
    return mixStops5(t, vec3(0.0, 0.0, 0.016), vec3(0.259, 0.039, 0.408), vec3(0.576, 0.169, 0.365), vec3(0.867, 0.318, 0.227), vec3(0.988, 1.0, 0.643));
  }
  if (paletteId == 3) {
    // jet
    return mixStops5(t, vec3(0.0, 0.0, 0.498), vec3(0.0, 0.498, 1.0), vec3(0.498, 1.0, 0.498), vec3(1.0, 0.498, 0.0), vec3(0.498, 0.0, 0.0));
  }
  if (paletteId == 4) {
    // magma
    return mixStops5(t, vec3(0.0, 0.0, 0.016), vec3(0.231, 0.059, 0.439), vec3(0.549, 0.161, 0.502), vec3(0.871, 0.286, 0.408), vec3(0.988, 0.992, 0.749));
  }
  if (paletteId == 5) {
    // twilight
    return mixStops5(t, vec3(0.184, 0.079, 0.213), vec3(0.384, 0.461, 0.731), vec3(0.886, 0.85, 0.886), vec3(0.698, 0.338, 0.322), vec3(0.184, 0.079, 0.213));
  }
  if (paletteId == 6) {
    // grayscale
    return vec3(t);
  }
  // viridis (default)
  return mixStops4(t, vec3(0.267, 0.004, 0.329), vec3(0.192, 0.408, 0.557), vec3(0.208, 0.718, 0.475), vec3(0.992, 0.906, 0.145));
}

void main() {
  if (fmColorModeId == 1) {
    gl_FragColor = vec4(orientationColor(vVectorValue), fmOpacity);
    return;
  }
  float s = vScalarValue;
  if (fmColorModeId == 2) {
    s = vVectorValue.x;
  } else if (fmColorModeId == 3) {
    s = vVectorValue.y;
  } else if (fmColorModeId == 4) {
    s = vVectorValue.z;
  } else if (fmColorModeId == 5) {
    s = length(vVectorValue);
  }

  float diff = fmScalarMax - fmScalarMin;
  float t = diff <= 0.0 ? 0.5 : clamp((s - fmScalarMin) / diff, 0.0, 1.0);
  vec3 rgb = paletteColor(t, fmPaletteId);
  gl_FragColor = vec4(rgb, fmOpacity);
}
`;

export function createFemCutSurfaceMaterial(options: {
  colormap?: string;
  opacity?: number;
  range: { max: number; min: number };
  vectorMode?: string;
}): ShaderMaterial {
  const opacity = options.opacity ?? 1;
  const material = new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    fragmentShader: FEM_CUT_SURFACE_FRAGMENT_SHADER,
    name: "FullmagFemCutSurfaceShaderMaterial",
    transparent: opacity < 1,
    uniforms: {
      fmColorModeId: { value: vectorModeId(options.vectorMode) },
      fmOpacity: { value: opacity },
      fmPaletteId: { value: paletteIdFromName(options.colormap) },
      fmScalarMax: { value: options.range.max },
      fmScalarMin: { value: options.range.min },
    },
    vertexShader: FEM_CUT_SURFACE_VERTEX_SHADER,
  });
  material.toneMapped = false;
  return material;
}

export function updateFemCutSurfaceMaterial(
  material: ShaderMaterial,
  options: {
    colormap?: string;
    opacity?: number;
    range: { max: number; min: number };
    vectorMode?: string;
  },
): void {
  const opacity = options.opacity ?? 1;
  material.uniforms.fmOpacity.value = opacity;
  material.uniforms.fmPaletteId.value = paletteIdFromName(options.colormap);
  material.uniforms.fmColorModeId.value = vectorModeId(options.vectorMode);
  material.uniforms.fmScalarMin.value = options.range.min;
  material.uniforms.fmScalarMax.value = options.range.max;
  material.transparent = opacity < 1;
}

export function disposeFemCutSurfaceMesh(mesh: Mesh): void {
  mesh.geometry?.dispose();
  if (Array.isArray(mesh.material)) {
    for (const mat of mesh.material) mat.dispose();
  } else {
    mesh.material?.dispose();
  }
}
