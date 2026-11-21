import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InterpolateLinear,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type KeyframeTrack,
  type Material,
} from "three";

import {
  evaluateVectorColorLinear,
  quantizeLinearRgb,
} from "./export3dColorEvaluator";
import {
  sanitizeGlTfNodeName,
  transformPositionByCoordinateTransform,
  type Export3DArrowAnchorMode,
  type Export3DColorMode,
  type Export3DCoordinateTransform,
  type Export3DIndexArray,
  type Export3DMaterialStyle,
  type Export3DNumericArray,
  type Export3DRgbTuple,
  type Export3DRenderedVectors,
  type Export3DScalarPalette,
  type Export3DScalarRange,
  type Export3DVectorLengthMode,
} from "./export3dTypes";

export interface UnitArrowGeometryOptions {
  radialSegments?: number;
  headLengthRatio?: number;
  headRadiusRatio?: number;
  shaftRadiusRatio?: number;
}

const DEFAULT_RADIAL_SEGMENTS = 10;
const DEFAULT_HEAD_LENGTH_RATIO = 0.28;
const DEFAULT_HEAD_RADIUS_RATIO = 0.1;
const DEFAULT_SHAFT_RADIUS_RATIO = 0.035;
const MIN_VECTOR_NORM = 1e-30;
const UNIT_Y = new Vector3(0, 1, 0);

/**
 * Builds a canonical unit 3D arrow along `+Y` from `y = 0` (tail) to `y = 1`
 * (tip), composed of a cylinder shaft with bottom cap and a cone head with
 * collar cap. All triangles are strictly outward-facing CCW.
 */
export function createUnitArrowGeometry(
  options: UnitArrowGeometryOptions = {},
): BufferGeometry {
  const radialSegments = Math.max(
    6,
    Math.floor(options.radialSegments ?? DEFAULT_RADIAL_SEGMENTS),
  );
  const headLengthRatio = Math.min(
    0.75,
    Math.max(0.05, options.headLengthRatio ?? DEFAULT_HEAD_LENGTH_RATIO),
  );
  const shaftLength = 1 - headLengthRatio;
  const headRadius = Math.max(0.01, options.headRadiusRatio ?? DEFAULT_HEAD_RADIUS_RATIO);
  const shaftRadius = Math.min(
    headRadius * 0.9,
    Math.max(0.005, options.shaftRadiusRatio ?? DEFAULT_SHAFT_RADIUS_RATIO),
  );

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const pushVertex = (
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): number => {
    const idx = positions.length / 3;
    positions.push(px, py, pz);
    normals.push(nx, ny, nz);
    return idx;
  };

  // 1. Shaft bottom cap (y = 0, normal -Y).
  const bottomCenter = pushVertex(0, 0, 0, 0, -1, 0);
  const bottomRingStart = positions.length / 3;
  for (let seg = 0; seg <= radialSegments; seg += 1) {
    const phi = (seg / radialSegments) * Math.PI * 2;
    pushVertex(
      shaftRadius * Math.sin(phi),
      0,
      shaftRadius * Math.cos(phi),
      0,
      -1,
      0,
    );
  }
  for (let seg = 0; seg < radialSegments; seg += 1) {
    indices.push(bottomCenter, bottomRingStart + seg + 1, bottomRingStart + seg);
  }

  // 2. Shaft cylinder wall (y = 0 -> shaftLength).
  const shaftWallStart = positions.length / 3;
  for (let seg = 0; seg <= radialSegments; seg += 1) {
    const phi = (seg / radialSegments) * Math.PI * 2;
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    pushVertex(shaftRadius * sinP, 0, shaftRadius * cosP, sinP, 0, cosP);
    pushVertex(shaftRadius * sinP, shaftLength, shaftRadius * cosP, sinP, 0, cosP);
  }
  for (let seg = 0; seg < radialSegments; seg += 1) {
    const b0 = shaftWallStart + seg * 2;
    const t0 = b0 + 1;
    const b1 = b0 + 2;
    const t1 = b0 + 3;
    indices.push(b0, b1, t1);
    indices.push(b0, t1, t0);
  }

  // 3. Cone base collar (y = shaftLength, normal -Y).
  const collarCenter = pushVertex(0, shaftLength, 0, 0, -1, 0);
  const collarRingStart = positions.length / 3;
  for (let seg = 0; seg <= radialSegments; seg += 1) {
    const phi = (seg / radialSegments) * Math.PI * 2;
    pushVertex(
      headRadius * Math.sin(phi),
      shaftLength,
      headRadius * Math.cos(phi),
      0,
      -1,
      0,
    );
  }
  for (let seg = 0; seg < radialSegments; seg += 1) {
    indices.push(collarCenter, collarRingStart + seg + 1, collarRingStart + seg);
  }

  // 4. Cone head lateral wall (y = shaftLength -> 1).
  const slopeHypot = Math.hypot(headLengthRatio, headRadius);
  const nyCone = headRadius / slopeHypot;
  const nrCone = headLengthRatio / slopeHypot;
  const coneBaseStart = positions.length / 3;
  for (let seg = 0; seg <= radialSegments; seg += 1) {
    const phi = (seg / radialSegments) * Math.PI * 2;
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    pushVertex(
      headRadius * sinP,
      shaftLength,
      headRadius * cosP,
      nrCone * sinP,
      nyCone,
      nrCone * cosP,
    );
  }
  for (let seg = 0; seg < radialSegments; seg += 1) {
    const phiMid = ((seg + 0.5) / radialSegments) * Math.PI * 2;
    const tipIdx = pushVertex(
      0,
      1,
      0,
      nrCone * Math.sin(phiMid),
      nyCone,
      nrCone * Math.cos(phiMid),
    );
    indices.push(coneBaseStart + seg, coneBaseStart + seg + 1, tipIdx);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  return geometry;
}

/**
 * Deterministic spatial point sampler for arbitrary 3D meshes / point clouds.
 * Allocates samples across occupied 3D spatial bins so arrows distribute evenly
 * over the geometry regardless of node ordering.
 */
export function samplePointIndicesSpatially(
  positionsM: Export3DNumericArray,
  maxSamples: number,
  candidateIndices?: Export3DIndexArray | null,
): Uint32Array {
  const budget = Math.max(0, Math.floor(Number.isFinite(maxSamples) ? maxSamples : 0));
  const totalPoints = Math.floor(positionsM.length / 3);
  if (budget <= 0 || totalPoints <= 0) return new Uint32Array(0);

  const uniqueCandidates: number[] = [];
  const seen = new Set<number>();
  const sourceCount = candidateIndices ? candidateIndices.length : totalPoints;
  for (let i = 0; i < sourceCount; i += 1) {
    const idx = candidateIndices ? Number(candidateIndices[i]) : i;
    if (!Number.isInteger(idx) || idx < 0 || idx >= totalPoints || seen.has(idx)) {
      continue;
    }
    const px = positionsM[idx * 3] ?? Number.NaN;
    const py = positionsM[idx * 3 + 1] ?? Number.NaN;
    const pz = positionsM[idx * 3 + 2] ?? Number.NaN;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
      continue;
    }
    seen.add(idx);
    uniqueCandidates.push(idx);
  }

  if (uniqueCandidates.length <= budget) {
    return Uint32Array.from(uniqueCandidates);
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const idx of uniqueCandidates) {
    const x = positionsM[idx * 3]!;
    const y = positionsM[idx * 3 + 1]!;
    const z = positionsM[idx * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const extent: [number, number, number] = [
    Math.max(maxX - minX, 0),
    Math.max(maxY - minY, 0),
    Math.max(maxZ - minZ, 0),
  ];
  const bins = resolveSpatialBinCounts(extent, budget);
  const buckets = new Map<number, number[]>();

  for (const idx of uniqueCandidates) {
    const x = positionsM[idx * 3]!;
    const y = positionsM[idx * 3 + 1]!;
    const z = positionsM[idx * 3 + 2]!;
    const bx = extent[0] > 0 ? Math.min(bins[0] - 1, Math.floor(((x - minX) / extent[0]) * bins[0])) : 0;
    const by = extent[1] > 0 ? Math.min(bins[1] - 1, Math.floor(((y - minY) / extent[1]) * bins[1])) : 0;
    const bz = extent[2] > 0 ? Math.min(bins[2] - 1, Math.floor(((z - minZ) / extent[2]) * bins[2])) : 0;
    const key = bx + bins[0] * (by + bins[1] * bz);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(idx);
  }

  const bucketEntries = Array.from(buckets.entries()).sort(([a], [b]) => a - b);
  const targetCount = Math.min(uniqueCandidates.length, budget);
  const extraNeeded = Math.max(0, targetCount - bucketEntries.length);
  const extraCapacity = Math.max(0, uniqueCandidates.length - bucketEntries.length);

  const allocations = bucketEntries.map(([key, values]) => {
    const cap = values.length - 1;
    const exactExtra = extraCapacity > 0 ? (cap * extraNeeded) / extraCapacity : 0;
    const whole = Math.floor(exactExtra);
    return { key, values, extra: whole, remainder: exactExtra - whole };
  });

  let allocated = allocations.reduce((sum, item) => sum + item.extra, 0);
  const sortedRemainders = [...allocations].sort(
    (a, b) => b.remainder - a.remainder || a.key - b.key,
  );
  for (const item of sortedRemainders) {
    if (allocated >= extraNeeded) break;
    if (item.extra + 1 < item.values.length) {
      item.extra += 1;
      allocated += 1;
    }
  }

  const selected: number[] = [];
  for (const item of allocations) {
    const slots = Math.min(item.values.length, item.extra + 1);
    for (let s = 0; s < slots; s += 1) {
      const pick = Math.min(
        item.values.length - 1,
        Math.floor(((s + 0.5) * item.values.length) / slots),
      );
      selected.push(item.values[pick]!);
    }
  }
  return Uint32Array.from(selected.slice(0, targetCount));
}

function resolveSpatialBinCounts(
  extent: readonly [number, number, number],
  budget: number,
): [number, number, number] {
  const activeAxes = extent.filter((size) => size > 0);
  if (activeAxes.length === 0) return [1, 1, 1];
  const minPos = Math.min(...activeAxes);
  const weights = extent.map((size) => (size > 0 ? Math.max(1, size / minPos) : 0));
  const productWeight = weights.reduce((acc, w) => (w > 0 ? acc * w : acc), 1);
  const scale = Math.pow(budget / Math.max(productWeight, 1), 1 / activeAxes.length);
  const bins: [number, number, number] = [
    weights[0] > 0 ? Math.max(1, Math.round(weights[0] * scale)) : 1,
    weights[1] > 0 ? Math.max(1, Math.round(weights[1] * scale)) : 1,
    weights[2] > 0 ? Math.max(1, Math.round(weights[2] * scale)) : 1,
  ];
  while (bins[0] * bins[1] * bins[2] > budget) {
    let largestAxis = 0;
    for (let axis = 1; axis < 3; axis += 1) {
      if (bins[axis] > bins[largestAxis]) largestAxis = axis;
    }
    if (bins[largestAxis] <= 1) break;
    bins[largestAxis] -= 1;
  }
  return bins;
}

export function computeAutoArrowBaseLengthM(params: {
  boundsSizeM: readonly [number, number, number];
  sampledCount: number;
  cellSizeM?: readonly [number, number, number] | null;
  arrowLengthScale?: number;
}): number {
  const scaleMultiplier = Math.max(0.05, params.arrowLengthScale ?? 1);
  const count = Math.max(1, params.sampledCount);
  const nonZeroDims = params.boundsSizeM.filter((d) => Number.isFinite(d) && d > 0);
  let characteristicSpacing = 1;

  if (nonZeroDims.length > 0) {
    const maxDim = Math.max(...nonZeroDims);
    const activeDims = nonZeroDims.filter((d) => d > maxDim * 0.05);
    const dimCount = Math.max(1, activeDims.length);
    const measure = activeDims.reduce((acc, d) => acc * d, 1);
    characteristicSpacing = Math.pow(measure / count, 1 / dimCount);
  }

  if (params.cellSizeM) {
    const maxCell = Math.max(params.cellSizeM[0], params.cellSizeM[1], params.cellSizeM[2]);
    characteristicSpacing = Math.max(characteristicSpacing, maxCell);
  }

  return Math.max(1e-18, characteristicSpacing * 0.8 * scaleMultiplier);
}

export interface StaticArrowGeometryInput {
  anchorsM: Export3DNumericArray;
  vectors: Export3DNumericArray;
  maxMagnitude: number;
  baseArrowLengthM: number;
  anchorMode: Export3DArrowAnchorMode;
  vectorLengthMode: Export3DVectorLengthMode;
  coordinateTransform: Export3DCoordinateTransform;
  colorMode: Export3DColorMode;
  colorPalette: Export3DScalarPalette;
  colorRange: Export3DScalarRange;
  monochromeColor?: Export3DRgbTuple;
  vertexColors?: Float32Array | null;
  radialSegments?: number;
  headRadiusRatio?: number;
  shaftRadiusRatio?: number;
}

/**
 * Builds one merged BufferGeometry containing all sampled 3D arrows with
 * `COLOR_0` linear-sRGB vertex colors for static glTF/GLB export.
 */
export function buildMergedStaticArrowGeometry(
  input: StaticArrowGeometryInput,
): { geometry: BufferGeometry; arrowCount: number } | null {
  const count = Math.min(
    Math.floor(input.anchorsM.length / 3),
    Math.floor(input.vectors.length / 3),
  );
  if (count <= 0) return null;

  const unit = createUnitArrowGeometry({
    radialSegments: input.radialSegments,
    headRadiusRatio: input.headRadiusRatio,
    shaftRadiusRatio: input.shaftRadiusRatio,
  });
  const unitPos = unit.getAttribute("position") as BufferAttribute;
  const unitNorm = unit.getAttribute("normal") as BufferAttribute;
  const unitIdx = unit.getIndex();
  const unitVertCount = unitPos.count;
  const unitIdxCount = unitIdx ? unitIdx.count : unitVertCount;

  const safeMaxMag = Math.max(input.maxMagnitude, MIN_VECTOR_NORM);
  const validSites: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const vx = input.vectors[i * 3] ?? 0;
    const vy = input.vectors[i * 3 + 1] ?? 0;
    const vz = input.vectors[i * 3 + 2] ?? 0;
    const mag = Math.hypot(vx, vy, vz);
    if (Number.isFinite(mag) && mag > MIN_VECTOR_NORM) {
      validSites.push(i);
    }
  }
  if (validSites.length === 0) {
    unit.dispose();
    return null;
  }

  const arrowCount = validSites.length;
  const totalVerts = arrowCount * unitVertCount;
  const totalIndices = arrowCount * unitIdxCount;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices =
    totalVerts < 65535
      ? new Uint16Array(totalIndices)
      : new Uint32Array(totalIndices);

  const dir = new Vector3();
  const quat = new Quaternion();
  const localPos = new Vector3();
  const localNorm = new Vector3();

  for (let outIdx = 0; outIdx < arrowCount; outIdx += 1) {
    const siteIdx = validSites[outIdx]!;
    const aBase = siteIdx * 3;
    const vx = input.vectors[aBase] ?? 0;
    const vy = input.vectors[aBase + 1] ?? 0;
    const vz = input.vectors[aBase + 2] ?? 0;
    const mag = Math.hypot(vx, vy, vz);
    dir.set(vx / mag, vy / mag, vz / mag);
    quat.setFromUnitVectors(UNIT_Y, dir);

    const lenFactor =
      input.vectorLengthMode === "uniform" ? 1 : Math.min(1, mag / safeMaxMag);
    const arrowLengthScene =
      input.baseArrowLengthM * lenFactor * input.coordinateTransform.unitsPerMeter;
    const [axScene, ayScene, azScene] = transformPositionByCoordinateTransform(
      input.anchorsM[aBase] ?? 0,
      input.anchorsM[aBase + 1] ?? 0,
      input.anchorsM[aBase + 2] ?? 0,
      input.coordinateTransform,
    );
    const tailOffset = input.anchorMode === "center" ? 0.5 * arrowLengthScene : 0;
    const originX = axScene - dir.x * tailOffset;
    const originY = ayScene - dir.y * tailOffset;
    const originZ = azScene - dir.z * tailOffset;

    const rgb = input.vertexColors
      ? input.vertexColors.subarray(aBase, aBase + 3)
      : evaluateVectorColorLinear(
          input.colorMode,
          input.colorPalette,
          input.colorRange,
          3,
          vx,
          vy,
          vz,
          input.monochromeColor,
        );

    const vertBase = outIdx * unitVertCount;
    for (let v = 0; v < unitVertCount; v += 1) {
      localPos
        .set(unitPos.getX(v), unitPos.getY(v), unitPos.getZ(v))
        .multiplyScalar(arrowLengthScene)
        .applyQuaternion(quat);
      localNorm
        .set(unitNorm.getX(v), unitNorm.getY(v), unitNorm.getZ(v))
        .applyQuaternion(quat)
        .normalize();

      const dst = (vertBase + v) * 3;
      positions[dst] = originX + localPos.x;
      positions[dst + 1] = originY + localPos.y;
      positions[dst + 2] = originZ + localPos.z;
      normals[dst] = localNorm.x;
      normals[dst + 1] = localNorm.y;
      normals[dst + 2] = localNorm.z;
      colors[dst] = rgb[0] ?? 0;
      colors[dst + 1] = rgb[1] ?? 0;
      colors[dst + 2] = rgb[2] ?? 0;
    }

    const idxBase = outIdx * unitIdxCount;
    for (let k = 0; k < unitIdxCount; k += 1) {
      const srcIndex = unitIdx ? unitIdx.getX(k) : k;
      indices[idxBase + k] = vertBase + srcIndex;
    }
  }

  unit.dispose();

  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(positions, 3));
  merged.setAttribute("normal", new BufferAttribute(normals, 3));
  merged.setAttribute("color", new BufferAttribute(colors, 3));
  merged.setIndex(new BufferAttribute(indices, 1));
  return { geometry: merged, arrowCount };
}

export function buildRenderedStaticArrowGeometry(
  rendered: Export3DRenderedVectors,
  coordinateTransform: Export3DCoordinateTransform,
): ReturnType<typeof buildMergedStaticArrowGeometry> {
  const count = rendered.segmentsM.length / 7;
  if (!Number.isInteger(count) || (rendered.colors && rendered.colors.length !== count * 3)) {
    throw new RangeError("Viewport arrow geometry and colors differ in size.");
  }
  const anchorsM = new Float64Array(count * 3);
  const vectors = new Float64Array(count * 3);
  let maxLengthM = 0;
  for (let index = 0; index < count; index += 1) {
    const segmentOffset = index * 7;
    const vectorOffset = index * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const tail = rendered.segmentsM[segmentOffset + axis]!;
      anchorsM[vectorOffset + axis] = tail;
      vectors[vectorOffset + axis] = rendered.segmentsM[segmentOffset + axis + 3]! - tail;
    }
    maxLengthM = Math.max(maxLengthM, Math.hypot(
      vectors[vectorOffset]!, vectors[vectorOffset + 1]!, vectors[vectorOffset + 2]!,
    ));
  }
  return buildMergedStaticArrowGeometry({
    anchorsM,
    vectors,
    maxMagnitude: maxLengthM,
    baseArrowLengthM: maxLengthM,
    anchorMode: "tail",
    vectorLengthMode: "proportional",
    coordinateTransform,
    colorMode: "monochrome",
    colorPalette: "viridis",
    colorRange: { min: 0, max: 1 },
    monochromeColor: rendered.monochromeColor,
    vertexColors: rendered.colors,
    headRadiusRatio: rendered.headRadiusRatio,
    shaftRadiusRatio: rendered.shaftRadiusRatio,
  });
}

export interface AnimatedArrowBuildInput {
  targetId: string;
  anchorsM: Float32Array;
  /** Length = keyframeCount * siteCount * 3 */
  frameVectors: readonly Float32Array[];
  keyframeTimes: readonly number[];
  maxMagnitude: number;
  baseArrowLengthM: number;
  anchorMode: Export3DArrowAnchorMode;
  vectorLengthMode: Export3DVectorLengthMode;
  coordinateTransform: Export3DCoordinateTransform;
  materialStyle: Export3DMaterialStyle;
  opacity: number;
  colorMode: Export3DColorMode;
  colorPalette: Export3DScalarPalette;
  colorRange: Export3DScalarRange;
  monochromeColor?: Export3DRgbTuple;
  usedNodeNames: Set<string>;
  radialSegments?: number;
  maxQuantizationLevels?: number;
}

export interface AnimatedArrowBuildResult {
  meshes: Mesh[];
  tracks: KeyframeTrack[];
  sharedGeometry: BufferGeometry;
  materials: Material[];
  arrowCount: number;
}

/**
 * Builds animated 3D arrow Mesh nodes sharing ONE unit arrow BufferGeometry and
 * a bounded quantized palette of shared materials, plus smooth `InterpolateLinear`
 * `.position`, `.quaternion`, and `.scale` KeyframeTracks with quaternion sign continuity.
 */
export function buildAnimatedArrowMeshesAndTracks(
  input: AnimatedArrowBuildInput,
): AnimatedArrowBuildResult | null {
  const siteCount = Math.floor(input.anchorsM.length / 3);
  const keyframeCount = input.frameVectors.length;
  if (siteCount <= 0 || keyframeCount <= 0 || input.keyframeTimes.length !== keyframeCount) {
    return null;
  }

  const sharedGeometry = createUnitArrowGeometry({
    radialSegments: input.radialSegments,
  });
  const materialMap = new Map<string, Material>();
  const levels = Math.max(2, Math.floor(input.maxQuantizationLevels ?? 4));
  const safeMaxMag = Math.max(input.maxMagnitude, MIN_VECTOR_NORM);
  const transparent = input.opacity < 1;

  const resolveMaterial = (rgbLinear: Export3DRgbTuple): Material => {
    const quantized =
      input.colorMode === "monochrome"
        ? {
            key: "mono",
            rgb: [rgbLinear[0], rgbLinear[1], rgbLinear[2]] as [number, number, number],
          }
        : quantizeLinearRgb(rgbLinear, levels);
    let material = materialMap.get(quantized.key);
    if (!material) {
      const color = new Color().setRGB(
        quantized.rgb[0],
        quantized.rgb[1],
        quantized.rgb[2],
        LinearSRGBColorSpace,
      );
      material =
        input.materialStyle === "pbr"
          ? new MeshStandardMaterial({
              color,
              roughness: 0.45,
              metalness: 0.08,
              side: DoubleSide,
              transparent,
              opacity: input.opacity,
            })
          : new MeshBasicMaterial({
              color,
              side: DoubleSide,
              transparent,
              opacity: input.opacity,
            });
      materialMap.set(quantized.key, material);
    }
    return material;
  };

  const meshes: Mesh[] = [];
  const tracks: KeyframeTrack[] = [];
  const timesCopy = Float32Array.from(input.keyframeTimes);
  const dir = new Vector3();
  const quat = new Quaternion();

  for (let siteIdx = 0; siteIdx < siteCount; siteIdx += 1) {
    const aBase = siteIdx * 3;
    const anchorXM = input.anchorsM[aBase] ?? 0;
    const anchorYM = input.anchorsM[aBase + 1] ?? 0;
    const anchorZM = input.anchorsM[aBase + 2] ?? 0;
    const [axScene, ayScene, azScene] = transformPositionByCoordinateTransform(
      anchorXM,
      anchorYM,
      anchorZM,
      input.coordinateTransform,
    );

    // Pick initial non-zero direction across frames as fallback if frame 0 is zero.
    let fallbackDir: [number, number, number] = [0, 1, 0];
    let anyNonZero = false;
    let colorFrameIdx = 0;
    for (let f = 0; f < keyframeCount; f += 1) {
      const fv = input.frameVectors[f]!;
      const vx = fv[aBase] ?? 0;
      const vy = fv[aBase + 1] ?? 0;
      const vz = fv[aBase + 2] ?? 0;
      const mag = Math.hypot(vx, vy, vz);
      if (Number.isFinite(mag) && mag > MIN_VECTOR_NORM) {
        fallbackDir = [vx / mag, vy / mag, vz / mag];
        anyNonZero = true;
        colorFrameIdx = f;
        break;
      }
    }
    if (!anyNonZero) continue;

    const colorSrc = input.frameVectors[colorFrameIdx]!;
    const initialRgb = evaluateVectorColorLinear(
      input.colorMode,
      input.colorPalette,
      input.colorRange,
      3,
      colorSrc[aBase] ?? 0,
      colorSrc[aBase + 1] ?? 0,
      colorSrc[aBase + 2] ?? 0,
      input.monochromeColor,
    );
    const material = resolveMaterial(initialRgb);

    const posValues = new Float32Array(keyframeCount * 3);
    const quatValues = new Float32Array(keyframeCount * 4);
    const scaleValues = new Float32Array(keyframeCount * 3);

    let prevDirX = fallbackDir[0];
    let prevDirY = fallbackDir[1];
    let prevDirZ = fallbackDir[2];
    let prevQx = 0;
    let prevQy = 0;
    let prevQz = 0;
    let prevQw = 1;
    let hasPrevQuat = false;

    for (let f = 0; f < keyframeCount; f += 1) {
      const fv = input.frameVectors[f]!;
      const vx = fv[aBase] ?? 0;
      const vy = fv[aBase + 1] ?? 0;
      const vz = fv[aBase + 2] ?? 0;
      const mag = Math.hypot(vx, vy, vz);
      const isValid = Number.isFinite(mag) && mag > MIN_VECTOR_NORM;

      const ux = isValid ? vx / mag : prevDirX;
      const uy = isValid ? vy / mag : prevDirY;
      const uz = isValid ? vz / mag : prevDirZ;
      if (isValid) {
        prevDirX = ux;
        prevDirY = uy;
        prevDirZ = uz;
      }

      dir.set(ux, uy, uz);
      quat.setFromUnitVectors(UNIT_Y, dir);
      if (hasPrevQuat) {
        const dot =
          prevQx * quat.x + prevQy * quat.y + prevQz * quat.z + prevQw * quat.w;
        if (dot < 0) {
          quat.set(-quat.x, -quat.y, -quat.z, -quat.w);
        }
      }
      prevQx = quat.x;
      prevQy = quat.y;
      prevQz = quat.z;
      prevQw = quat.w;
      hasPrevQuat = true;

      const lenFactor = !isValid
        ? 0
        : input.vectorLengthMode === "uniform"
          ? 1
          : Math.min(1, mag / safeMaxMag);
      const arrowLengthScene =
        input.baseArrowLengthM * lenFactor * input.coordinateTransform.unitsPerMeter;
      const tailOffset = input.anchorMode === "center" ? 0.5 * arrowLengthScene : 0;

      const pDst = f * 3;
      posValues[pDst] = axScene - ux * tailOffset;
      posValues[pDst + 1] = ayScene - uy * tailOffset;
      posValues[pDst + 2] = azScene - uz * tailOffset;

      const qDst = f * 4;
      quatValues[qDst] = quat.x;
      quatValues[qDst + 1] = quat.y;
      quatValues[qDst + 2] = quat.z;
      quatValues[qDst + 3] = quat.w;

      scaleValues[pDst] = arrowLengthScene;
      scaleValues[pDst + 1] = arrowLengthScene;
      scaleValues[pDst + 2] = arrowLengthScene;
    }

    const nodeName = sanitizeGlTfNodeName(
      `${input.targetId}_arrow_${siteIdx}`,
      input.usedNodeNames,
      "arrow",
    );
    const mesh = new Mesh(sharedGeometry, material);
    mesh.name = nodeName;
    mesh.position.set(posValues[0]!, posValues[1]!, posValues[2]!);
    mesh.quaternion.set(quatValues[0]!, quatValues[1]!, quatValues[2]!, quatValues[3]!);
    mesh.scale.set(scaleValues[0]!, scaleValues[1]!, scaleValues[2]!);
    mesh.userData = {
      fullmag: {
        role: "vector_arrow",
        target_id: input.targetId,
        site_index: siteIdx,
        anchor_m: [anchorXM, anchorYM, anchorZM],
      },
    };
    meshes.push(mesh);

    if (keyframeCount > 1) {
      tracks.push(
        new VectorKeyframeTrack(
          `${nodeName}.position`,
          timesCopy,
          posValues,
          InterpolateLinear,
        ),
        new QuaternionKeyframeTrack(
          `${nodeName}.quaternion`,
          timesCopy,
          quatValues,
          InterpolateLinear,
        ),
        new VectorKeyframeTrack(
          `${nodeName}.scale`,
          timesCopy,
          scaleValues,
          InterpolateLinear,
        ),
      );
    }
  }

  if (meshes.length === 0) {
    sharedGeometry.dispose();
    for (const mat of materialMap.values()) {
      mat.dispose();
    }
    return null;
  }

  return {
    meshes,
    tracks,
    sharedGeometry,
    materials: Array.from(materialMap.values()),
    arrowCount: meshes.length,
  };
}
