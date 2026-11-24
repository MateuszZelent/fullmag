import {
  BufferGeometry,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";

import {
  buildArray3DInstanceMatrices,
  extractArray3DPreviewDescriptors,
  type Array3DPreviewDescriptor,
} from "./Array3DInstancedPreviewLayer";
import {
  createPrimitiveObjectGeometry,
  resolvePrimitiveGroupTransform,
} from "./PrimitiveObjectLayerModel";
import { createScenePreviewBufferGeometry } from "./previewGeometryBuilder";
import type { Viewport3DPrimitiveObject } from "../viewport3dPrimitiveModel";

const MAX_SURFACE_PREVIEW_TRIANGLES = 24_000;
const MAX_TEXTURE_PREVIEW_ARRAY_INSTANCES = 256;
const DEFAULT_SUBDIVISION_PASSES = 6;

export interface SubdividedSurfacePreviewData {
  readonly positionsWorld: Float32Array;
  readonly indices: Uint32Array;
  readonly sourceGeometryType?: string;
  readonly analyticalHoleCount?: number;
  readonly instanceCount?: number;
}

interface MutableSurfaceBuffers {
  positions: number[];
  indices: number[];
}

/**
 * Composes the exact world Matrix4 matching `PrimitiveObjectLayer`'s `<group>`
 * transform (`resolvePrimitiveGroupTransform`).
 */
export function composePrimitiveObjectWorldMatrix(
  object: Viewport3DPrimitiveObject,
): Matrix4 {
  const groupTransform = resolvePrimitiveGroupTransform(object);
  return new Matrix4().compose(
    new Vector3(...groupTransform.position),
    new Quaternion(...groupTransform.quaternion),
    new Vector3(...groupTransform.scale),
  );
}

function extractWeldedTriangleMesh(
  geometry: BufferGeometry,
  transformMatrix: Matrix4,
  weldScaleHint: number,
): MutableSurfaceBuffers {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr || posAttr.count === 0) {
    return { positions: [], indices: [] };
  }

  const flipWinding = transformMatrix.determinant() < 0;
  const invQuantum = 1 / Math.max(weldScaleHint * 1e-6, 1e-15);
  const positions: number[] = [];
  const vertexMap = new Map<string, number>();
  const remapped = new Int32Array(posAttr.count);
  const v = new Vector3();

  for (let i = 0; i < posAttr.count; i += 1) {
    v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(transformMatrix);
    const qx = Math.round(v.x * invQuantum);
    const qy = Math.round(v.y * invQuantum);
    const qz = Math.round(v.z * invQuantum);
    const key = `${qx}:${qy}:${qz}`;
    const existing = vertexMap.get(key);
    if (existing !== undefined) {
      remapped[i] = existing;
    } else {
      const nextIdx = positions.length / 3;
      positions.push(v.x, v.y, v.z);
      vertexMap.set(key, nextIdx);
      remapped[i] = nextIdx;
    }
  }

  const indices: number[] = [];
  const srcIndex = geometry.index;
  if (srcIndex) {
    for (let t = 0; t + 2 < srcIndex.count; t += 3) {
      const a = remapped[srcIndex.getX(t)]!;
      const b = remapped[srcIndex.getX(t + 1)]!;
      const c = remapped[srcIndex.getX(t + 2)]!;
      if (a === b || b === c || c === a) continue;
      if (flipWinding) {
        indices.push(a, c, b);
      } else {
        indices.push(a, b, c);
      }
    }
  } else {
    for (let t = 0; t + 2 < posAttr.count; t += 3) {
      const a = remapped[t]!;
      const b = remapped[t + 1]!;
      const c = remapped[t + 2]!;
      if (a === b || b === c || c === a) continue;
      if (flipWinding) {
        indices.push(a, c, b);
      } else {
        indices.push(a, b, c);
      }
    }
  }

  return { positions, indices };
}

function subdivideMutableMesh(
  mesh: MutableSurfaceBuffers,
  maxEdge: number,
  maxTriangles: number,
  maxPasses: number,
): void {
  const safeMaxEdge = Math.max(maxEdge, 1e-12);
  const maxEdgeSq = safeMaxEdge * safeMaxEdge;
  const { positions } = mesh;
  let { indices } = mesh;

  const distSq = (i0: number, i1: number): number => {
    const b0 = i0 * 3;
    const b1 = i1 * 3;
    const dx = positions[b0]! - positions[b1]!;
    const dy = positions[b0 + 1]! - positions[b1 + 1]!;
    const dz = positions[b0 + 2]! - positions[b1 + 2]!;
    return dx * dx + dy * dy + dz * dz;
  };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const triCount = Math.floor(indices.length / 3);
    if (triCount === 0 || triCount >= maxTriangles) break;

    let anySplit = false;
    let projectedTriCount = triCount;
    const nextIndices: number[] = [];
    const midpointCache = new Map<string, number>();

    const getMidpoint = (i0: number, i1: number): number => {
      const lo = i0 < i1 ? i0 : i1;
      const hi = i0 < i1 ? i1 : i0;
      const key = `${lo}:${hi}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const idx = positions.length / 3;
      const b0 = i0 * 3;
      const b1 = i1 * 3;
      positions.push(
        0.5 * (positions[b0]! + positions[b1]!),
        0.5 * (positions[b0 + 1]! + positions[b1 + 1]!),
        0.5 * (positions[b0 + 2]! + positions[b1 + 2]!),
      );
      midpointCache.set(key, idx);
      return idx;
    };

    for (let t = 0; t + 2 < indices.length; t += 3) {
      const i0 = indices[t]!;
      const i1 = indices[t + 1]!;
      const i2 = indices[t + 2]!;
      const s01 = distSq(i0, i1) > maxEdgeSq;
      const s12 = distSq(i1, i2) > maxEdgeSq;
      const s20 = distSq(i2, i0) > maxEdgeSq;
      const splitCount = (s01 ? 1 : 0) + (s12 ? 1 : 0) + (s20 ? 1 : 0);

      if (splitCount === 0 || projectedTriCount + splitCount > maxTriangles) {
        nextIndices.push(i0, i1, i2);
        continue;
      }

      anySplit = true;
      projectedTriCount += splitCount;

      if (splitCount === 3) {
        const m01 = getMidpoint(i0, i1);
        const m12 = getMidpoint(i1, i2);
        const m20 = getMidpoint(i2, i0);
        nextIndices.push(
          i0, m01, m20,
          m01, i1, m12,
          m20, m12, i2,
          m01, m12, m20,
        );
      } else if (splitCount === 2) {
        // Cyclic rotation so unsplit edge is (c, a) and split edges are (a, b), (b, c)
        let a = i0;
        let b = i1;
        let c = i2;
        if (!s01) {
          a = i1;
          b = i2;
          c = i0;
        } else if (!s12) {
          a = i2;
          b = i0;
          c = i1;
        }
        const mab = getMidpoint(a, b);
        const mbc = getMidpoint(b, c);
        nextIndices.push(mab, b, mbc);
        if (distSq(a, mbc) <= distSq(c, mab)) {
          nextIndices.push(a, mab, mbc, a, mbc, c);
        } else {
          nextIndices.push(a, mab, c, mab, mbc, c);
        }
      } else {
        // Cyclic rotation so split edge is (a, b)
        let a = i0;
        let b = i1;
        let c = i2;
        if (s12) {
          a = i1;
          b = i2;
          c = i0;
        } else if (s20) {
          a = i2;
          b = i0;
          c = i1;
        }
        const mab = getMidpoint(a, b);
        nextIndices.push(a, mab, c, mab, b, c);
      }
    }

    indices = nextIndices;
    if (!anySplit) break;
  }

  mesh.indices = indices;
}

/**
 * Transforms a BufferGeometry into world space, welds duplicate vertices, and
 * applies conforming 1/2/3-edge midpoint subdivision so analytical spin textures
 * stay sharp across large flat faces while preserving every hole and silhouette.
 */
export function subdivideBufferGeometryToWorldSurface(
  geometry: BufferGeometry,
  worldMatrix: Matrix4,
  options: {
    readonly maxEdge: number;
    readonly maxTriangles?: number;
    readonly maxPasses?: number;
    readonly weldScaleHint?: number;
  },
): { positionsWorld: Float32Array; indices: Uint32Array } {
  const mesh = extractWeldedTriangleMesh(
    geometry,
    worldMatrix,
    options.weldScaleHint ?? options.maxEdge * 20,
  );
  subdivideMutableMesh(
    mesh,
    options.maxEdge,
    options.maxTriangles ?? MAX_SURFACE_PREVIEW_TRIANGLES,
    options.maxPasses ?? DEFAULT_SUBDIVISION_PASSES,
  );
  return {
    positionsWorld: new Float32Array(mesh.positions),
    indices: new Uint32Array(mesh.indices),
  };
}

function appendArray3DDescriptorToBuffers(
  descriptor: Array3DPreviewDescriptor,
  gridRes: number,
  triangleBudget: number,
  outPositions: number[],
  outIndices: number[],
): {
  sourceGeometryType: string;
  analyticalHoleCount?: number;
  instanceCount: number;
} {
  const matrices = buildArray3DInstanceMatrices(
    descriptor,
    MAX_TEXTURE_PREVIEW_ARRAY_INSTANCES,
  );
  if (matrices.length === 0) {
    return { sourceGeometryType: "BufferGeometry", instanceCount: 0 };
  }

  const childGeom = createScenePreviewBufferGeometry(descriptor.childGeometry);
  const sourceGeometryType = childGeom.type;
  const analyticalHoleCount =
    typeof childGeom.userData?.analyticalHoleCount === "number"
      ? childGeom.userData.analyticalHoleCount
      : undefined;

  try {
    const childMaxSpan = Math.max(
      descriptor.childSize[0],
      descriptor.childSize[1],
      descriptor.childSize[2],
      1e-12,
    );
    const perInstanceMaxTris = Math.max(
      12,
      Math.floor(triangleBudget / Math.max(1, matrices.length)),
    );
    const targetDivs = Math.max(4, Math.min(20, Math.floor(gridRes * 0.6)));
    const childMesh = extractWeldedTriangleMesh(
      childGeom,
      new Matrix4(),
      childMaxSpan,
    );
    subdivideMutableMesh(
      childMesh,
      Math.max(childMaxSpan / targetDivs, 1e-12),
      perInstanceMaxTris,
      4,
    );

    const childVertCount = childMesh.positions.length / 3;
    const v = new Vector3();

    for (const mat of matrices) {
      const vertexBase = outPositions.length / 3;
      const flipWinding = mat.determinant() < 0;
      for (let i = 0; i < childVertCount; i += 1) {
        const src = i * 3;
        v.set(
          childMesh.positions[src]!,
          childMesh.positions[src + 1]!,
          childMesh.positions[src + 2]!,
        ).applyMatrix4(mat);
        outPositions.push(v.x, v.y, v.z);
      }
      for (let t = 0; t + 2 < childMesh.indices.length; t += 3) {
        const a = vertexBase + childMesh.indices[t]!;
        const b = vertexBase + childMesh.indices[t + 1]!;
        const c = vertexBase + childMesh.indices[t + 2]!;
        if (flipWinding) {
          outIndices.push(a, c, b);
        } else {
          outIndices.push(a, b, c);
        }
      }
    }

    return {
      sourceGeometryType,
      ...(analyticalHoleCount !== undefined ? { analyticalHoleCount } : {}),
      instanceCount: matrices.length,
    };
  } finally {
    childGeom.dispose();
  }
}

function buildTransformedSubdividedBox(
  object: Viewport3DPrimitiveObject,
  gridRes: number,
  worldMatrix: Matrix4,
): SubdividedSurfacePreviewData {
  const n = Math.max(4, Math.min(64, Math.floor(gridRes)));
  const [sx, sy, sz] = object.localSize ?? object.bounds.size;
  const hx = Math.max(sx * 0.5, 1e-12);
  const hy = Math.max(sy * 0.5, 1e-12);
  const hz = Math.max(sz * 0.5, 1e-12);
  const flipWinding = worldMatrix.determinant() < 0;
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new Vector3();

  const addPatch = (
    origin: readonly [number, number, number],
    uVec: readonly [number, number, number],
    vVec: readonly [number, number, number],
    nu: number,
    nv: number,
  ) => {
    const base = positions.length / 3;
    for (let iv = 0; iv <= nv; iv += 1) {
      const tv = iv / nv;
      for (let iu = 0; iu <= nu; iu += 1) {
        const tu = iu / nu;
        v.set(
          origin[0] + uVec[0] * tu + vVec[0] * tv,
          origin[1] + uVec[1] * tu + vVec[1] * tv,
          origin[2] + uVec[2] * tu + vVec[2] * tv,
        ).applyMatrix4(worldMatrix);
        positions.push(v.x, v.y, v.z);
      }
    }
    const stride = nu + 1;
    for (let iv = 0; iv < nv; iv += 1) {
      for (let iu = 0; iu < nu; iu += 1) {
        const a = base + iv * stride + iu;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        if (flipWinding) {
          indices.push(a, d, b, a, c, d);
        } else {
          indices.push(a, b, d, a, d, c);
        }
      }
    }
  };

  const thinSteps = Math.max(2, Math.min(8, Math.floor(n / 4)));
  addPatch([-hx, -hy, hz], [2 * hx, 0, 0], [0, 2 * hy, 0], n, n);
  addPatch([hx, -hy, -hz], [-2 * hx, 0, 0], [0, 2 * hy, 0], n, n);
  addPatch([-hx, -hy, -hz], [2 * hx, 0, 0], [0, 0, 2 * hz], n, thinSteps);
  addPatch([hx, hy, -hz], [-2 * hx, 0, 0], [0, 0, 2 * hz], n, thinSteps);
  addPatch([hx, -hy, -hz], [0, 2 * hy, 0], [0, 0, 2 * hz], thinSteps, thinSteps);
  addPatch([-hx, hy, -hz], [0, -2 * hy, 0], [0, 0, 2 * hz], thinSteps, thinSteps);

  return {
    positionsWorld: new Float32Array(positions),
    indices: new Uint32Array(indices),
    sourceGeometryType: "BoxGeometry",
  };
}

function buildTransformedSubdividedSphere(
  object: Viewport3DPrimitiveObject,
  gridRes: number,
  worldMatrix: Matrix4,
): SubdividedSurfacePreviewData {
  const n = Math.max(4, Math.min(64, Math.floor(gridRes)));
  const [sx, sy, sz] = object.localSize ?? object.bounds.size;
  const rx = Math.max(sx * 0.5, 1e-12);
  const ry = Math.max(sy * 0.5, 1e-12);
  const rz = Math.max(sz * 0.5, 1e-12);
  const flipWinding = worldMatrix.determinant() < 0;
  const stacks = Math.max(8, Math.floor(n / 2));
  const slices = n;
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new Vector3();

  for (let is = 0; is <= stacks; is += 1) {
    const phi = (Math.PI * is) / stacks;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let it = 0; it <= slices; it += 1) {
      const theta = (2 * Math.PI * it) / slices;
      v.set(
        rx * sinPhi * Math.cos(theta),
        ry * sinPhi * Math.sin(theta),
        rz * cosPhi,
      ).applyMatrix4(worldMatrix);
      positions.push(v.x, v.y, v.z);
    }
  }
  const stride = slices + 1;
  for (let is = 0; is < stacks; is += 1) {
    for (let it = 0; it < slices; it += 1) {
      const a = is * stride + it;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      if (flipWinding) {
        indices.push(a, b, c, b, d, c);
      } else {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  return {
    positionsWorld: new Float32Array(positions),
    indices: new Uint32Array(indices),
    sourceGeometryType: "SphereGeometry",
  };
}

/**
 * Builds a world-space subdivided surface mesh for Magnetic Texture rendering
 * that respects the EXACT CSG / composite / primitive / Array3D topology of
 * `object` (never covering cut-out holes with a solid box!).
 */
export function buildTopologySurfacePreviewData(
  object: Viewport3DPrimitiveObject,
  gridRes = 32,
): SubdividedSurfacePreviewData {
  const safeRes = Math.max(4, Math.min(64, Math.floor(gridRes)));

  // Top-level Array3D: replicate subdivided child geometry across ALL instances
  if (object.kind === "array3d" && object.rawGeometry) {
    const descriptors = extractArray3DPreviewDescriptors([object]);
    const direct = descriptors[0];
    if (direct) {
      const positions: number[] = [];
      const indices: number[] = [];
      const meta = appendArray3DDescriptorToBuffers(
        direct,
        safeRes,
        MAX_SURFACE_PREVIEW_TRIANGLES,
        positions,
        indices,
      );
      if (positions.length > 0 && indices.length > 0) {
        return {
          positionsWorld: new Float32Array(positions),
          indices: new Uint32Array(indices),
          sourceGeometryType: meta.sourceGeometryType,
          ...(meta.analyticalHoleCount !== undefined
            ? { analyticalHoleCount: meta.analyticalHoleCount }
            : {}),
          instanceCount: meta.instanceCount,
        };
      }
    }
  }

  const worldMatrix = composePrimitiveObjectWorldMatrix(object);

  if (object.kind === "sphere") {
    return buildTransformedSubdividedSphere(object, safeRes, worldMatrix);
  }

  // Exact topology path for CSG differences, composites (Box - Array3D(Holes), Union,
  // Cone, Torus, Ellipsoid, PolygonPrism, Translate, SlicePlane), cylinders, antennas, imports
  if (
    object.kind === "composite" ||
    object.kind === "box-cylinder-difference" ||
    object.kind === "cylinder-cylinder-difference" ||
    object.kind === "cylinder" ||
    object.kind === "imported-surface" ||
    object.kind === "microstrip" ||
    object.kind === "cpw"
  ) {
    const maxSpan = Math.max(
      object.bounds.size[0],
      object.bounds.size[1],
      object.bounds.size[2],
      1e-12,
    );
    const maxEdge = Math.max(maxSpan / Math.max(8, Math.min(28, safeRes)), 1e-12);
    const baseGeom = createPrimitiveObjectGeometry(object);
    const sourceGeometryType = baseGeom.type;
    const analyticalHoleCount =
      typeof baseGeom.userData?.analyticalHoleCount === "number"
        ? baseGeom.userData.analyticalHoleCount
        : undefined;

    let mesh: MutableSurfaceBuffers;
    try {
      mesh = extractWeldedTriangleMesh(baseGeom, worldMatrix, maxSpan);
      subdivideMutableMesh(
        mesh,
        maxEdge,
        MAX_SURFACE_PREVIEW_TRIANGLES,
        DEFAULT_SUBDIVISION_PASSES,
      );
    } finally {
      baseGeom.dispose();
    }

    // Union/Xor composites may also carry nested non-cutter Array3D operands
    let nestedArrayInstances = 0;
    if (object.kind === "composite" && object.rawGeometry) {
      const nestedArrays = extractArray3DPreviewDescriptors([object]).filter(
        (d) => !d.isCutter,
      );
      if (nestedArrays.length > 0) {
        const remainingBudget = Math.max(
          200,
          MAX_SURFACE_PREVIEW_TRIANGLES - Math.floor(mesh.indices.length / 3),
        );
        const perDescBudget = Math.floor(remainingBudget / nestedArrays.length);
        for (const desc of nestedArrays) {
          const meta = appendArray3DDescriptorToBuffers(
            desc,
            safeRes,
            perDescBudget,
            mesh.positions,
            mesh.indices,
          );
          nestedArrayInstances += meta.instanceCount;
        }
      }
    }

    if (mesh.positions.length > 0 && mesh.indices.length > 0) {
      return {
        positionsWorld: new Float32Array(mesh.positions),
        indices: new Uint32Array(mesh.indices),
        sourceGeometryType,
        ...(analyticalHoleCount !== undefined ? { analyticalHoleCount } : {}),
        ...(nestedArrayInstances > 0 ? { instanceCount: nestedArrayInstances } : {}),
      };
    }
  }

  return buildTransformedSubdividedBox(object, safeRes, worldMatrix);
}

/**
 * Deterministic area-weighted surface point sampler for general curved or stepped
 * 3D composite geometries (`Torus`, `Cone`, `Ellipsoid`, stepped `Union`, `SlicePlane`).
 */
export function sampleCompositeSurfaceVectorAnchors(
  object: Viewport3DPrimitiveObject,
  targetCount: number,
  liftFn: (pitch: number) => number,
): { positionsWorld: Float32Array; pitch: number; count: number } | null {
  if (targetCount <= 0) return null;
  const geom = createPrimitiveObjectGeometry(object);
  const worldMatrix = composePrimitiveObjectWorldMatrix(object);
  const flipWinding = worldMatrix.determinant() < 0;

  try {
    const posAttr = geom.getAttribute("position");
    if (!posAttr || posAttr.count < 3) return null;
    const srcIndex = geom.index;
    const triCount = srcIndex
      ? Math.floor(srcIndex.count / 3)
      : Math.floor(posAttr.count / 3);
    if (triCount <= 0) return null;

    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const ab = new Vector3();
    const ac = new Vector3();
    const cross = new Vector3();

    const cdf = new Float64Array(triCount);
    let totalArea = 0;
    for (let t = 0; t < triCount; t += 1) {
      const i0 = srcIndex ? srcIndex.getX(t * 3) : t * 3;
      const i1 = srcIndex ? srcIndex.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = srcIndex ? srcIndex.getX(t * 3 + 2) : t * 3 + 2;
      a.set(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0)).applyMatrix4(worldMatrix);
      b.set(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1)).applyMatrix4(worldMatrix);
      c.set(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2)).applyMatrix4(worldMatrix);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const area = 0.5 * cross.crossVectors(ab, ac).length();
      totalArea += area;
      cdf[t] = totalArea;
    }

    if (!Number.isFinite(totalArea) || totalArea <= 1e-30) return null;

    const pitch = Math.max(1e-12, Math.sqrt(totalArea / targetCount));
    const lift = liftFn(pitch);
    const out = new Float32Array(targetCount * 3);
    // Low-discrepancy R2 quasirandom sequence for even, deterministic barycentric sampling
    const g = 1.324717957244746;
    const alpha1 = 1 / g;
    const alpha2 = 1 / (g * g);

    for (let s = 0; s < targetCount; s += 1) {
      const targetArea = ((s + 0.5) / targetCount) * totalArea;
      // Binary search CDF
      let lo = 0;
      let hi = triCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cdf[mid]! < targetArea) lo = mid + 1;
        else hi = mid;
      }
      const i0 = srcIndex ? srcIndex.getX(lo * 3) : lo * 3;
      const i1 = srcIndex ? srcIndex.getX(lo * 3 + 1) : lo * 3 + 1;
      const i2 = srcIndex ? srcIndex.getX(lo * 3 + 2) : lo * 3 + 2;
      a.set(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0)).applyMatrix4(worldMatrix);
      b.set(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1)).applyMatrix4(worldMatrix);
      c.set(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2)).applyMatrix4(worldMatrix);

      if (flipWinding) {
        ab.subVectors(c, a);
        ac.subVectors(b, a);
      } else {
        ab.subVectors(b, a);
        ac.subVectors(c, a);
      }
      cross.crossVectors(ab, ac);
      const normLen = cross.length();
      if (normLen > 1e-24) {
        cross.divideScalar(normLen);
      } else {
        cross.set(0, 0, 1);
      }

      const u1 = ((s + 1) * alpha1) % 1;
      const u2 = ((s + 1) * alpha2) % 1;
      const sqrtU1 = Math.sqrt(u1);
      const w0 = 1 - sqrtU1;
      const w1 = sqrtU1 * (1 - u2);
      const w2 = sqrtU1 * u2;

      const dst = s * 3;
      out[dst] = a.x * w0 + b.x * w1 + c.x * w2 + cross.x * lift;
      out[dst + 1] = a.y * w0 + b.y * w1 + c.y * w2 + cross.y * lift;
      out[dst + 2] = a.z * w0 + b.z * w1 + c.z * w2 + cross.z * lift;
    }

    return { positionsWorld: out, pitch, count: targetCount };
  } finally {
    geom.dispose();
  }
}
