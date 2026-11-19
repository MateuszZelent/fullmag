import {
  EXPORT_3D_INACTIVE_REGION_ID,
  type Export3DIndexArray,
  type Export3DNumericArray,
} from "./export3dTypes";

export interface ExtractVoxelExteriorShellInput {
  gridShape: readonly [number, number, number];
  cellSizeM: readonly [number, number, number];
  originM?: readonly [number, number, number];
  activeMask?: Uint8Array | readonly number[] | null;
  regionIds?: Uint32Array | readonly number[] | null;
}

export interface FdmActiveCellMask {
  activeFlags: Uint8Array;
  activeCellIndices: Uint32Array;
  activeOrdinalByCell: Int32Array;
  activeCellCount: number;
  totalCells: number;
}

export interface VoxelExteriorShell {
  positionsM: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCellIndices: Uint32Array;
  faceCellIndices: Uint32Array;
  surfaceCellIndices: Uint32Array;
  activeCellIndices: Uint32Array;
  activeOrdinalByCell: Int32Array;
  vertexCount: number;
  triangleCount: number;
  faceCount: number;
  activeCellCount: number;
  boundsMinM: [number, number, number];
  boundsMaxM: [number, number, number];
}

interface VoxelFaceDescriptor {
  readonly axis: 0 | 1 | 2;
  readonly step: -1 | 1;
  readonly normal: readonly [number, number, number];
  readonly corners: readonly (readonly [0 | 1, 0 | 1, 0 | 1])[];
}

const VOXEL_FACES: readonly VoxelFaceDescriptor[] = [
  {
    axis: 0,
    step: -1,
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
  },
  {
    axis: 0,
    step: 1,
    normal: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    axis: 1,
    step: -1,
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    axis: 1,
    step: 1,
    normal: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    axis: 2,
    step: -1,
    normal: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
  {
    axis: 2,
    step: 1,
    normal: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  },
];

const FEATURE_COSINE_THRESHOLD = Math.cos((1 * Math.PI) / 180);

export function validateFdmGridInput(
  gridShape: readonly [number, number, number],
  cellSizeM: readonly [number, number, number],
  originM: readonly [number, number, number] = [0, 0, 0],
): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const dim = gridShape[axis];
    const spacing = cellSizeM[axis];
    const origin = originM[axis];
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new RangeError(`gridShape[${axis}] must be a positive integer, got ${String(dim)}`);
    }
    if (!Number.isFinite(spacing) || spacing <= 0) {
      throw new RangeError(`cellSizeM[${axis}] must be finite and > 0, got ${String(spacing)}`);
    }
    if (!Number.isFinite(origin)) {
      throw new RangeError(`originM[${axis}] must be finite, got ${String(origin)}`);
    }
  }
}

export function resolveFdmActiveCellMask(
  gridShape: readonly [number, number, number],
  activeMask?: Uint8Array | readonly number[] | null,
  regionIds?: Uint32Array | readonly number[] | null,
): FdmActiveCellMask {
  const [nx, ny, nz] = gridShape;
  const totalCells = nx * ny * nz;
  if (activeMask != null && activeMask.length !== totalCells) {
    throw new RangeError(
      `activeMask length (${activeMask.length}) does not match grid cell count (${totalCells})`,
    );
  }
  if (activeMask == null && regionIds != null && regionIds.length !== totalCells) {
    throw new RangeError(
      `regionIds length (${regionIds.length}) does not match grid cell count (${totalCells})`,
    );
  }

  const activeFlags = new Uint8Array(totalCells);
  const activeOrdinalByCell = new Int32Array(totalCells).fill(-1);
  let activeCellCount = 0;

  for (let cell = 0; cell < totalCells; cell += 1) {
    const isActive =
      activeMask != null
        ? Boolean(activeMask[cell])
        : regionIds != null
          ? (regionIds[cell] ?? EXPORT_3D_INACTIVE_REGION_ID) !==
            EXPORT_3D_INACTIVE_REGION_ID
          : true;
    if (isActive) {
      activeFlags[cell] = 1;
      activeOrdinalByCell[cell] = activeCellCount;
      activeCellCount += 1;
    }
  }

  const activeCellIndices = new Uint32Array(activeCellCount);
  let cursor = 0;
  for (let cell = 0; cell < totalCells; cell += 1) {
    if (activeFlags[cell] === 1) {
      activeCellIndices[cursor] = cell;
      cursor += 1;
    }
  }

  return {
    activeFlags,
    activeCellIndices,
    activeOrdinalByCell,
    activeCellCount,
    totalCells,
  };
}

export function computeFdmCellCentersM(
  gridShape: readonly [number, number, number],
  cellSizeM: readonly [number, number, number],
  originM: readonly [number, number, number] = [0, 0, 0],
  cellIndices?: Export3DIndexArray | null,
): Float32Array {
  validateFdmGridInput(gridShape, cellSizeM, originM);
  const [nx, ny] = gridShape;
  const [dx, dy, dz] = cellSizeM;
  const [ox, oy, oz] = originM;
  const planeStride = nx * ny;
  const totalCells = planeStride * gridShape[2];
  const count = cellIndices ? cellIndices.length : totalCells;
  const centers = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const cell = cellIndices ? (cellIndices[i] ?? 0) : i;
    const ix = cell % nx;
    const iy = Math.floor(cell / nx) % ny;
    const iz = Math.floor(cell / planeStride);
    const dst = i * 3;
    centers[dst] = ox + (ix + 0.5) * dx;
    centers[dst + 1] = oy + (iy + 0.5) * dy;
    centers[dst + 2] = oz + (iz + 0.5) * dz;
  }
  return centers;
}

/**
 * Extracts a face-culled exterior triangle shell from a regular 3D FDM lattice.
 * Each emitted quad face owns 4 distinct vertices so per-cell flat shading and
 * sharp voxel colors stay crisp without cross-cell color bleeding.
 */
export function extractVoxelExteriorShell(
  input: ExtractVoxelExteriorShellInput,
): VoxelExteriorShell {
  const originM = input.originM ?? [0, 0, 0];
  validateFdmGridInput(input.gridShape, input.cellSizeM, originM);

  const [nx, ny, nz] = input.gridShape;
  const [dx, dy, dz] = input.cellSizeM;
  const [ox, oy, oz] = originM;
  const planeStride = nx * ny;
  const mask = resolveFdmActiveCellMask(
    input.gridShape,
    input.activeMask,
    input.regionIds,
  );

  if (mask.activeCellCount === 0) {
    return {
      positionsM: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      vertexCellIndices: new Uint32Array(0),
      faceCellIndices: new Uint32Array(0),
      surfaceCellIndices: new Uint32Array(0),
      activeCellIndices: mask.activeCellIndices,
      activeOrdinalByCell: mask.activeOrdinalByCell,
      vertexCount: 0,
      triangleCount: 0,
      faceCount: 0,
      activeCellCount: 0,
      boundsMinM: [ox, oy, oz],
      boundsMaxM: [ox, oy, oz],
    };
  }

  const isCellActive = (ix: number, iy: number, iz: number): boolean => {
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) {
      return false;
    }
    return mask.activeFlags[ix + nx * (iy + ny * iz)] === 1;
  };

  let faceCount = 0;
  let surfaceCellCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let idx = 0; idx < mask.activeCellIndices.length; idx += 1) {
    const cell = mask.activeCellIndices[idx]!;
    const ix = cell % nx;
    const iy = Math.floor(cell / nx) % ny;
    const iz = Math.floor(cell / planeStride);

    const x0 = ox + ix * dx;
    const y0 = oy + iy * dy;
    const z0 = oz + iz * dz;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (z0 < minZ) minZ = z0;
    if (x0 + dx > maxX) maxX = x0 + dx;
    if (y0 + dy > maxY) maxY = y0 + dy;
    if (z0 + dz > maxZ) maxZ = z0 + dz;

    let exposedOnCell = 0;
    if (!isCellActive(ix - 1, iy, iz)) exposedOnCell += 1;
    if (!isCellActive(ix + 1, iy, iz)) exposedOnCell += 1;
    if (!isCellActive(ix, iy - 1, iz)) exposedOnCell += 1;
    if (!isCellActive(ix, iy + 1, iz)) exposedOnCell += 1;
    if (!isCellActive(ix, iy, iz - 1)) exposedOnCell += 1;
    if (!isCellActive(ix, iy, iz + 1)) exposedOnCell += 1;
    if (exposedOnCell > 0) {
      faceCount += exposedOnCell;
      surfaceCellCount += 1;
    }
  }

  const vertexCount = faceCount * 4;
  const triangleCount = faceCount * 2;
  const positionsM = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  const vertexCellIndices = new Uint32Array(vertexCount);
  const faceCellIndices = new Uint32Array(faceCount);
  const surfaceCellIndices = new Uint32Array(surfaceCellCount);

  let faceCursor = 0;
  let surfaceCellCursor = 0;

  for (let idx = 0; idx < mask.activeCellIndices.length; idx += 1) {
    const cell = mask.activeCellIndices[idx]!;
    const ix = cell % nx;
    const iy = Math.floor(cell / nx) % ny;
    const iz = Math.floor(cell / planeStride);

    const xs: [number, number] = [ox + ix * dx, ox + (ix + 1) * dx];
    const ys: [number, number] = [oy + iy * dy, oy + (iy + 1) * dy];
    const zs: [number, number] = [oz + iz * dz, oz + (iz + 1) * dz];

    let cellHasExposedFace = false;
    for (const face of VOXEL_FACES) {
      const nix = face.axis === 0 ? ix + face.step : ix;
      const niy = face.axis === 1 ? iy + face.step : iy;
      const niz = face.axis === 2 ? iz + face.step : iz;
      if (isCellActive(nix, niy, niz)) continue;

      cellHasExposedFace = true;
      const baseVertex = faceCursor * 4;
      const [fnx, fny, fnz] = face.normal;

      for (let cornerIdx = 0; cornerIdx < 4; cornerIdx += 1) {
        const corner = face.corners[cornerIdx]!;
        const vIdx = baseVertex + cornerIdx;
        const pDst = vIdx * 3;
        positionsM[pDst] = xs[corner[0]];
        positionsM[pDst + 1] = ys[corner[1]];
        positionsM[pDst + 2] = zs[corner[2]];
        normals[pDst] = fnx;
        normals[pDst + 1] = fny;
        normals[pDst + 2] = fnz;
        vertexCellIndices[vIdx] = cell;
      }

      const iDst = faceCursor * 6;
      indices[iDst] = baseVertex;
      indices[iDst + 1] = baseVertex + 1;
      indices[iDst + 2] = baseVertex + 2;
      indices[iDst + 3] = baseVertex;
      indices[iDst + 4] = baseVertex + 2;
      indices[iDst + 5] = baseVertex + 3;

      faceCellIndices[faceCursor] = cell;
      faceCursor += 1;
    }

    if (cellHasExposedFace) {
      surfaceCellIndices[surfaceCellCursor] = cell;
      surfaceCellCursor += 1;
    }
  }

  return {
    positionsM,
    normals,
    indices,
    vertexCellIndices,
    faceCellIndices,
    surfaceCellIndices,
    activeCellIndices: mask.activeCellIndices,
    activeOrdinalByCell: mask.activeOrdinalByCell,
    vertexCount,
    triangleCount,
    faceCount,
    activeCellCount: mask.activeCellCount,
    boundsMinM: [minX, minY, minZ],
    boundsMaxM: [maxX, maxY, maxZ],
  };
}

/**
 * Extracts non-coplanar feature edges and open boundary edges from a triangle
 * surface mesh, omitting interior triangulation diagonals across flat faces.
 */
export function buildSurfaceFeatureEdgePositions(
  positions: Export3DNumericArray,
  triangleIndices: Export3DIndexArray | null | undefined,
): Float32Array {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount < 3) return new Float32Array(0);
  const triCount = triangleIndices
    ? Math.floor(triangleIndices.length / 3)
    : Math.floor(vertexCount / 3);
  if (triCount <= 0) return new Float32Array(0);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const tolerance = Math.max(extent * 1e-7, 1e-30);
  const canonicalIdByKey = new Map<string, number>();
  const canonicalVertexIds = new Int32Array(vertexCount);

  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    const key = `${Math.round(x / tolerance)}_${Math.round(y / tolerance)}_${Math.round(z / tolerance)}`;
    let id = canonicalIdByKey.get(key);
    if (id === undefined) {
      id = canonicalIdByKey.size;
      canonicalIdByKey.set(key, id);
    }
    canonicalVertexIds[i] = id;
  }

  interface EdgeEntry {
    aIdx: number;
    bIdx: number;
    nx: number;
    ny: number;
    nz: number;
    count: number;
    isFeature: boolean;
  }

  const edges = new Map<string, EdgeEntry>();
  for (let tri = 0; tri < triCount; tri += 1) {
    const i0 = triangleIndices ? (triangleIndices[tri * 3] ?? 0) : tri * 3;
    const i1 = triangleIndices ? (triangleIndices[tri * 3 + 1] ?? 0) : tri * 3 + 1;
    const i2 = triangleIndices ? (triangleIndices[tri * 3 + 2] ?? 0) : tri * 3 + 2;
    if (
      i0 < 0 ||
      i1 < 0 ||
      i2 < 0 ||
      i0 >= vertexCount ||
      i1 >= vertexCount ||
      i2 >= vertexCount
    ) {
      continue;
    }

    const ax = positions[i0 * 3] ?? 0;
    const ay = positions[i0 * 3 + 1] ?? 0;
    const az = positions[i0 * 3 + 2] ?? 0;
    const bx = positions[i1 * 3] ?? 0;
    const by = positions[i1 * 3 + 1] ?? 0;
    const bz = positions[i1 * 3 + 2] ?? 0;
    const cx = positions[i2 * 3] ?? 0;
    const cy = positions[i2 * 3 + 1] ?? 0;
    const cz = positions[i2 * 3 + 2] ?? 0;

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    nx /= len;
    ny /= len;
    nz /= len;

    const pairs: readonly [number, number][] = [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ];
    for (const [u, v] of pairs) {
      const cu = canonicalVertexIds[u]!;
      const cv = canonicalVertexIds[v]!;
      if (cu === cv) continue;
      const edgeKey = cu < cv ? `${cu}_${cv}` : `${cv}_${cu}`;
      const existing = edges.get(edgeKey);
      if (!existing) {
        edges.set(edgeKey, {
          aIdx: u,
          bIdx: v,
          nx,
          ny,
          nz,
          count: 1,
          isFeature: false,
        });
      } else {
        existing.count += 1;
        const dot = existing.nx * nx + existing.ny * ny + existing.nz * nz;
        if (dot < FEATURE_COSINE_THRESHOLD) {
          existing.isFeature = true;
        }
      }
    }
  }

  let keptCount = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1 || edge.isFeature) keptCount += 1;
  }

  const linePositions = new Float32Array(keptCount * 6);
  let cursor = 0;
  for (const edge of edges.values()) {
    if (edge.count !== 1 && !edge.isFeature) continue;
    const aBase = edge.aIdx * 3;
    const bBase = edge.bIdx * 3;
    linePositions[cursor] = positions[aBase] ?? 0;
    linePositions[cursor + 1] = positions[aBase + 1] ?? 0;
    linePositions[cursor + 2] = positions[aBase + 2] ?? 0;
    linePositions[cursor + 3] = positions[bBase] ?? 0;
    linePositions[cursor + 4] = positions[bBase + 1] ?? 0;
    linePositions[cursor + 5] = positions[bBase + 2] ?? 0;
    cursor += 6;
  }
  return linePositions;
}
