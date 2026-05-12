import type { FemMeshData } from "./femMeshTypes";

type FieldData = NonNullable<FemMeshData["fieldData"]>;

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function downsampleVectorFieldSpatialBins(args: {
  nodes: ArrayLike<number>;
  nNodes: number;
  fieldData: FieldData | undefined;
  targetBins: number;
}): FieldData | undefined {
  const { nodes, nNodes, fieldData } = args;
  const targetBins = clampInteger(args.targetBins, 1, Math.max(1, nNodes));
  if (!fieldData || nNodes <= 0 || targetBins >= nNodes) {
    return fieldData;
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < nNodes; i += 1) {
    const x = nodes[i * 3] ?? 0;
    const y = nodes[i * 3 + 1] ?? 0;
    const z = nodes[i * 3 + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  const rawSpanX = maxX - minX;
  const rawSpanY = maxY - minY;
  const rawSpanZ = maxZ - minZ;
  const spanX = Math.max(rawSpanX, 1e-30);
  const spanY = Math.max(rawSpanY, 1e-30);
  const spanZ = Math.max(rawSpanZ, 1e-30);
  const nonzeroSpans = [rawSpanX, rawSpanY, rawSpanZ].filter((span) => span > 1e-30);
  const measure = nonzeroSpans.reduce((product, span) => product * span, 1);
  const cellSize = Math.pow(Math.max(measure, 1e-30) / targetBins, 1 / Math.max(1, nonzeroSpans.length));
  const nx = rawSpanX <= 1e-30 ? 1 : Math.max(1, Math.ceil(rawSpanX / cellSize));
  const ny = rawSpanY <= 1e-30 ? 1 : Math.max(1, Math.ceil(rawSpanY / cellSize));
  const nz = rawSpanZ <= 1e-30 ? 1 : Math.max(1, Math.ceil(rawSpanZ / cellSize));
  const actualBins = nx * ny * nz;

  const sumX = new Float64Array(actualBins);
  const sumY = new Float64Array(actualBins);
  const sumZ = new Float64Array(actualBins);
  const counts = new Uint32Array(actualBins);
  const nodeBin = new Uint32Array(nNodes);
  const invX = nx / spanX;
  const invY = ny / spanY;
  const invZ = nz / spanZ;

  for (let i = 0; i < nNodes; i += 1) {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor(((nodes[i * 3] ?? 0) - minX) * invX)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor(((nodes[i * 3 + 1] ?? 0) - minY) * invY)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor(((nodes[i * 3 + 2] ?? 0) - minZ) * invZ)));
    const bin = ix + iy * nx + iz * nx * ny;
    nodeBin[i] = bin;
    sumX[bin] += fieldData.x[i] ?? 0;
    sumY[bin] += fieldData.y[i] ?? 0;
    sumZ[bin] += fieldData.z[i] ?? 0;
    counts[bin] += 1;
  }

  for (let bin = 0; bin < actualBins; bin += 1) {
    const count = counts[bin];
    if (count <= 0) continue;
    sumX[bin] /= count;
    sumY[bin] /= count;
    sumZ[bin] /= count;
  }

  const x = new Float64Array(nNodes);
  const y = new Float64Array(nNodes);
  const z = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i += 1) {
    const bin = nodeBin[i];
    x[i] = sumX[bin];
    y[i] = sumY[bin];
    z[i] = sumZ[bin];
  }

  return { x, y, z };
}
