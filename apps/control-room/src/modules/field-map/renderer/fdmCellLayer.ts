import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
} from "three";

import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";
import { paletteIdFromName } from "./femCutSurfaceLayer";

export interface FdmCellLayerInput {
  bounds: readonly [number, number, number, number];
  colormap?: string;
  mask?: Uint8Array | null;
  opacity?: number;
  originOffset?: readonly [number, number];
  range: { max: number; min: number };
  resolution: readonly [number, number];
  scalar: Float32Array | Float64Array;
  smooth?: boolean;
}

export function createFdmCellQuadGeometry(
  bounds: readonly [number, number, number, number],
  originOffset?: readonly [number, number],
): BufferGeometry {
  const [originU, originV] = originOffset ?? [0, 0];
  const [uMin, uMax, vMin, vMax] = bounds;

  const x0 = uMin - originU;
  const x1 = uMax - originU;
  const y0 = vMin - originV;
  const y1 = vMax - originV;

  // 2 triangles: (0, 1, 2) and (0, 2, 3)
  const positions = new Float32Array([
    x0, y0, 0,
    x1, y0, 0,
    x1, y1, 0,
    x0, y0, 0,
    x1, y1, 0,
    x0, y1, 0,
  ]);

  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 0,
    1, 1,
    0, 1,
  ]);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  return geometry;
}

export function updateFdmCellQuadGeometry(
  geometry: BufferGeometry,
  bounds: readonly [number, number, number, number],
  originOffset?: readonly [number, number],
): void {
  const [originU, originV] = originOffset ?? [0, 0];
  const [uMin, uMax, vMin, vMax] = bounds;

  const x0 = uMin - originU;
  const x1 = uMax - originU;
  const y0 = vMin - originV;
  const y1 = vMax - originV;

  const posAttr = geometry.getAttribute("position");
  if (posAttr && posAttr.count === 6) {
    const array = posAttr.array as Float32Array;
    array[0] = x0; array[1] = y0; array[2] = 0;
    array[3] = x1; array[4] = y0; array[5] = 0;
    array[6] = x1; array[7] = y1; array[8] = 0;
    array[9] = x0; array[10] = y0; array[11] = 0;
    array[12] = x1; array[13] = y1; array[14] = 0;
    array[15] = x0; array[16] = y1; array[17] = 0;
    posAttr.needsUpdate = true;
  }
}

export function createFdmDataTexture(
  scalar: Float32Array | Float64Array,
  resolution: readonly [number, number],
  mask?: Uint8Array | null,
  smooth = false,
): DataTexture {
  const [width, height] = resolution;
  const totalPixels = width * height;
  const data = new Float32Array(totalPixels * 4);

  for (let i = 0; i < totalPixels; i++) {
    const val = scalar[i] ?? Number.NaN;
    const isOccupied = isRenderablePlanarOccupancy(mask?.[i]) && Number.isFinite(val);
    const offset = i * 4;
    data[offset] = isOccupied ? val : 0;
    data[offset + 1] = isOccupied ? 1.0 : 0.0;
    data[offset + 2] = 0;
    data[offset + 3] = 1.0;
  }

  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = smooth ? LinearFilter : NearestFilter;
  texture.minFilter = smooth ? LinearFilter : NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function updateFdmDataTexture(
  texture: DataTexture,
  scalar: Float32Array | Float64Array,
  resolution: readonly [number, number],
  mask?: Uint8Array | null,
  smooth = false,
): void {
  const [width, height] = resolution;
  const totalPixels = width * height;

  if (texture.image.width !== width || texture.image.height !== height) {
    texture.image.width = width;
    texture.image.height = height;
    texture.image.data = new Float32Array(totalPixels * 4);
  }

  const data = texture.image.data as Float32Array;
  for (let i = 0; i < totalPixels; i++) {
    const val = scalar[i] ?? Number.NaN;
    const isOccupied = isRenderablePlanarOccupancy(mask?.[i]) && Number.isFinite(val);
    const offset = i * 4;
    data[offset] = isOccupied ? val : 0;
    data[offset + 1] = isOccupied ? 1.0 : 0.0;
    data[offset + 2] = 0;
    data[offset + 3] = 1.0;
  }

  texture.magFilter = smooth ? LinearFilter : NearestFilter;
  texture.minFilter = smooth ? LinearFilter : NearestFilter;
  texture.needsUpdate = true;
}

const FDM_CELL_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FDM_CELL_FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D fmFieldTexture;
uniform float fmScalarMin;
uniform float fmScalarMax;
uniform float fmOpacity;
uniform int fmPaletteId;
varying vec2 vUv;

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
  vec4 sampleData = texture2D(fmFieldTexture, vUv);
  float s = sampleData.r;
  float occupied = sampleData.g;
  if (occupied < 0.5) {
    discard;
  }

  float diff = fmScalarMax - fmScalarMin;
  float t = diff <= 0.0 ? 0.5 : clamp((s - fmScalarMin) / diff, 0.0, 1.0);
  vec3 rgb = paletteColor(t, fmPaletteId);
  gl_FragColor = vec4(rgb, fmOpacity);
}
`;

export function createFdmCellMaterial(
  texture: DataTexture,
  options: {
    colormap?: string;
    opacity?: number;
    range: { max: number; min: number };
  },
): ShaderMaterial {
  const opacity = options.opacity ?? 1;
  const material = new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    fragmentShader: FDM_CELL_FRAGMENT_SHADER,
    name: "FullmagFdmCellShaderMaterial",
    transparent: true,
    uniforms: {
      fmFieldTexture: { value: texture },
      fmOpacity: { value: opacity },
      fmPaletteId: { value: paletteIdFromName(options.colormap) },
      fmScalarMax: { value: options.range.max },
      fmScalarMin: { value: options.range.min },
    },
    vertexShader: FDM_CELL_VERTEX_SHADER,
  });
  material.toneMapped = false;
  return material;
}

export function updateFdmCellMaterial(
  material: ShaderMaterial,
  texture: DataTexture,
  options: {
    colormap?: string;
    opacity?: number;
    range: { max: number; min: number };
  },
): void {
  material.uniforms.fmFieldTexture.value = texture;
  material.uniforms.fmOpacity.value = options.opacity ?? 1;
  material.uniforms.fmPaletteId.value = paletteIdFromName(options.colormap);
  material.uniforms.fmScalarMin.value = options.range.min;
  material.uniforms.fmScalarMax.value = options.range.max;
}

export function disposeFdmCellMesh(mesh: Mesh): void {
  mesh.geometry?.dispose();
  if (Array.isArray(mesh.material)) {
    for (const mat of mesh.material) mat.dispose();
  } else {
    const mat = mesh.material as ShaderMaterial | undefined;
    const tex = mat?.uniforms?.fmFieldTexture?.value as DataTexture | undefined;
    tex?.dispose();
    mat?.dispose();
  }
}
