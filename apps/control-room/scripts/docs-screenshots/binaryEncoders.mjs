import { createHash } from "node:crypto";

const FMVP_HEADER_LEN = 48;
const FMVP_KIND_F64 = 1;
const FMVP_KIND_F32 = 2;

const FMMT_V1_HEADER_LEN = 32;
const FMMT_KIND_F64_U32 = 1;

const FMRM_HEADER_LEN = 64;
const FMRM_VERSION = 2;
const FMRM_KIND_U32 = 2;

const FMTB_HEADER_LEN = 60;
const FMTB_VERSION = 1;

const FMCS_V2_HEADER_LEN = 64;
const FMCS_VERSION_V2 = 2;
const FMCS_FLAG_INTERSECTION_METADATA = 1;

const FMCS_V4_HEADER_LEN = 160;
const FMCS_VERSION_V4 = 4;

/**
 * Encodes an FMVP v2 scalar or vector field buffer matching fieldVectorCodec.ts.
 * Header layout (48 bytes):
 *   0..4   "FMVP"
 *   4      version (2)
 *   5      kind (1 = f64, 2 = f32)
 *   6      nComp (1 or 3)
 *   7      0
 *   8..12  metadataLength (0 for v2)
 *   12..16 valueCount (gridX * gridY * gridZ * nComp)
 *   16..20 gridX
 *   20..24 gridY
 *   24..28 gridZ
 *   28..44 quantityId (ASCII padded/truncated to 16 bytes)
 *   44..48 reserved (0)
 */
export function encodeFmvpV2({
  quantityId,
  grid,
  data,
  dtype = "float64",
  nComp = 1,
}) {
  const [gridX, gridY, gridZ] = grid;
  const expectedCount = gridX * gridY * gridZ * nComp;
  if (data.length !== expectedCount) {
    throw new Error(
      `encodeFmvpV2(${quantityId}): expected ${expectedCount} elements, got ${data.length}`,
    );
  }
  const isF32 = dtype === "float32";
  const bytesPerElem = isF32 ? 4 : 8;
  const buffer = new ArrayBuffer(FMVP_HEADER_LEN + expectedCount * bytesPerElem);
  const view = new DataView(buffer);

  writeAscii(view, 0, "FMVP");
  view.setUint8(4, 2);
  view.setUint8(5, isF32 ? FMVP_KIND_F32 : FMVP_KIND_F64);
  view.setUint8(6, nComp);
  view.setUint8(7, 0);
  view.setUint32(8, 0, true);
  view.setUint32(12, expectedCount, true);
  view.setUint32(16, gridX, true);
  view.setUint32(20, gridY, true);
  view.setUint32(24, gridZ, true);

  const idBytes = new TextEncoder().encode(quantityId);
  new Uint8Array(buffer, 28, 16).set(idBytes.subarray(0, 16));

  if (isF32) {
    new Float32Array(buffer, FMVP_HEADER_LEN, expectedCount).set(data);
  } else {
    new Float64Array(buffer, FMVP_HEADER_LEN, expectedCount).set(data);
  }
  return Buffer.from(buffer);
}

/**
 * Encodes an FMMT v1 tetrahedral topology buffer matching topologyCodec.ts.
 * Header layout (32 bytes):
 *   0..4   "FMMT"
 *   4      version (1)
 *   5      kind (1 = f64_u32)
 *   6..8   0
 *   8..12  nodeCount
 *   12..16 cellCount (4 nodes per tet)
 *   16..20 facetCount (3 nodes per tri)
 *   20..24 cellMarkerCount
 *   24..28 facetMarkerCount
 *   28..32 0
 */
export function encodeFmmtV1({
  positions,
  cellNodes,
  facetNodes,
  cellMarkers,
  facetMarkers,
}) {
  const nodeCount = positions.length / 3;
  const cellCount = cellNodes.length / 4;
  const facetCount = facetNodes.length / 3;
  const cellMarkerCount = cellMarkers.length;
  const facetMarkerCount = facetMarkers.length;

  if (!Number.isInteger(nodeCount) || !Number.isInteger(cellCount) || !Number.isInteger(facetCount)) {
    throw new Error("encodeFmmtV1: non-integer node/cell/facet counts");
  }

  const posBytes = positions.length * 8;
  const cellBytes = cellNodes.length * 4;
  const facetBytes = facetNodes.length * 4;
  const cellMarkerBytes = cellMarkers.length * 4;
  const facetMarkerBytes = facetMarkers.length * 4;
  const totalBytes =
    FMMT_V1_HEADER_LEN +
    posBytes +
    cellBytes +
    facetBytes +
    cellMarkerBytes +
    facetMarkerBytes;

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "FMMT");
  view.setUint8(4, 1);
  view.setUint8(5, FMMT_KIND_F64_U32);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, cellCount, true);
  view.setUint32(16, facetCount, true);
  view.setUint32(20, cellMarkerCount, true);
  view.setUint32(24, facetMarkerCount, true);

  let offset = FMMT_V1_HEADER_LEN;
  new Float64Array(buffer, offset, positions.length).set(positions);
  offset += posBytes;
  new Uint32Array(buffer, offset, cellNodes.length).set(cellNodes);
  offset += cellBytes;
  new Uint32Array(buffer, offset, facetNodes.length).set(facetNodes);
  offset += facetBytes;
  new Uint32Array(buffer, offset, cellMarkers.length).set(cellMarkers);
  offset += cellMarkerBytes;
  new Uint32Array(buffer, offset, facetMarkers.length).set(facetMarkers);

  return Buffer.from(buffer);
}

/**
 * Splits a rectangular box [x0..x1, y0..y1, z0..z1] into 6 non-overlapping
 * positively oriented tetrahedra plus 12 boundary triangles (2 per face).
 */
export function buildBoxTetrahedra(bounds, markerId = 1, baseNodeOffset = 0) {
  const { min, max } = bounds;
  const corners = [
    [min[0], min[1], min[2]], // 0: 000
    [max[0], min[1], min[2]], // 1: 100
    [max[0], max[1], min[2]], // 2: 110
    [min[0], max[1], min[2]], // 3: 010
    [min[0], min[1], max[2]], // 4: 001
    [max[0], min[1], max[2]], // 5: 101
    [max[0], max[1], max[2]], // 6: 111
    [min[0], max[1], max[2]], // 7: 011
  ];
  const positions = corners.flat();

  // Kuhn 6-tet decomposition along diagonal 0 -> 6.
  const tets = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
    [0, 5, 1, 6],
  ];
  const cellNodes = tets.flatMap((tet) => tet.map((idx) => idx + baseNodeOffset));
  const cellMarkers = new Array(tets.length).fill(markerId);

  // 12 outward-oriented boundary triangles (2 per face).
  const tris = [
    [0, 3, 2], [0, 2, 1], // z-
    [4, 5, 6], [4, 6, 7], // z+
    [0, 1, 5], [0, 5, 4], // y-
    [2, 3, 7], [2, 7, 6], // y+
    [0, 4, 7], [0, 7, 3], // x-
    [1, 2, 6], [1, 6, 5], // x+
  ];
  const facetNodes = tris.flatMap((tri) => tri.map((idx) => idx + baseNodeOffset));
  const facetMarkers = new Array(tris.length).fill(markerId);

  return {
    positions,
    cellNodes,
    cellMarkers,
    facetNodes,
    facetMarkers,
  };
}

/**
 * Generates an FMMT buffer containing an inner magnetic waveguide/disk block
 * (marker 1) surrounded by an outer FEM airbox (marker 2).
 */
export function buildFemAirboxTopology({
  coreBounds,
  airboxBounds,
  coreMarker = 1,
  airboxMarker = 2,
}) {
  const core = buildBoxTetrahedra(coreBounds, coreMarker, 0);
  const airbox = buildBoxTetrahedra(airboxBounds, airboxMarker, 8);
  const positions = [...core.positions, ...airbox.positions];
  const cellNodes = [...core.cellNodes, ...airbox.cellNodes];
  const cellMarkers = [...core.cellMarkers, ...airbox.cellMarkers];
  const facetNodes = [...core.facetNodes, ...airbox.facetNodes];
  const facetMarkers = [...core.facetMarkers, ...airbox.facetMarkers];
  return {
    buffer: encodeFmmtV1({
      positions,
      cellNodes,
      facetNodes,
      cellMarkers,
      facetMarkers,
    }),
    nodeCount: positions.length / 3,
    cellCount: cellMarkers.length,
    facetCount: facetMarkers.length,
    coreCellCount: core.cellMarkers.length,
    airboxCellCount: airbox.cellMarkers.length,
  };
}

/**
 * Computes canonical region_legend_fingerprint expected by fdmRegionMembershipCodec.ts.
 */
export function computeLegendFingerprint(regionLegend) {
  const canonical = regionLegend.map((entry) => ({
    numeric_id: entry.numeric_id,
    object_id: entry.object_id,
    region_id: entry.region_id,
    priority: entry.priority,
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

/**
 * Encodes an FMRM v2 region membership buffer matching fdmRegionMembershipCodec.ts.
 */
export function encodeFmrmV2({
  counts,
  legendCount,
  gridFingerprintHex,
  regionIds,
}) {
  const [nx, ny, nz] = counts;
  const cellCount = nx * ny * nz;
  if (regionIds.length !== cellCount) {
    throw new Error(`encodeFmrmV2: expected ${cellCount} cells, got ${regionIds.length}`);
  }
  const cleanHex = gridFingerprintHex.replace(/^sha256:/i, "").trim();
  if (cleanHex.length !== 64) {
    throw new Error(`encodeFmrmV2: gridFingerprintHex must be 64 hex chars`);
  }

  const buffer = new ArrayBuffer(FMRM_HEADER_LEN + cellCount * 4);
  const view = new DataView(buffer);
  writeAscii(view, 0, "FMRM");
  view.setUint8(4, FMRM_VERSION);
  view.setUint8(5, FMRM_KIND_U32);
  view.setUint32(8, nx, true);
  view.setUint32(12, ny, true);
  view.setUint32(16, nz, true);
  view.setUint32(20, cellCount, true);
  view.setUint32(24, legendCount, true);

  const fpBytes = Buffer.from(cleanHex, "hex");
  new Uint8Array(buffer, 28, 32).set(fpBytes);
  new Uint32Array(buffer, FMRM_HEADER_LEN, cellCount).set(regionIds);
  return Buffer.from(buffer);
}

/**
 * Encodes an FMTB v1 table rows buffer matching tableRowsCodec.ts.
 */
export function encodeFmtbV1({
  revision = 1,
  schemaRevision = 1,
  cursorStart = 0,
  cursorEnd,
  totalRows,
  rowCount,
  columnCount,
  values,
  resyncRequired = false,
}) {
  const expected = rowCount * columnCount;
  if (values.length !== expected) {
    throw new Error(`encodeFmtbV1: expected ${expected} floats, got ${values.length}`);
  }
  const buffer = new ArrayBuffer(FMTB_HEADER_LEN + expected * 8);
  const view = new DataView(buffer);
  writeAscii(view, 0, "FMTB");
  view.setUint16(4, FMTB_VERSION, true);
  view.setUint16(6, resyncRequired ? 1 : 0, true);
  view.setBigUint64(8, BigInt(revision), true);
  view.setBigUint64(16, BigInt(schemaRevision), true);
  view.setBigUint64(24, BigInt(cursorStart), true);
  view.setBigUint64(32, BigInt(cursorEnd ?? rowCount), true);
  view.setBigUint64(40, BigInt(totalRows ?? rowCount), true);
  view.setBigUint64(48, BigInt(rowCount), true);
  view.setUint32(56, columnCount, true);
  // FMTB_HEADER_LEN (60) is 4-byte aligned, not 8-byte aligned; copy bytes safely.
  const f64 = values instanceof Float64Array ? values : Float64Array.from(values);
  new Uint8Array(buffer, FMTB_HEADER_LEN, expected * 8).set(
    new Uint8Array(f64.buffer, f64.byteOffset, expected * 8),
  );
  return Buffer.from(buffer);
}

/**
 * Encodes an FMCS v2 mesh cross-section geometry + intersection metadata buffer
 * matching crossSectionCodec.ts decodeCrossSection (64-byte header).
 */
export function encodeFmcsV2({ plane = "yz", positionPercent = 50 } = {}) {
  const cols = 6;
  const rows = 3;
  const polygonCount = cols * rows;
  const vertexCount = polygonCount * 4;
  const segmentCount = polygonCount * 4;

  const uMin = -120e-9;
  const uMax = 120e-9;
  const vMin = -48e-9;
  const vMax = 48e-9;
  const sliceAxisHalf = 140e-9;
  const pct = Number.isFinite(Number(positionPercent)) ? Number(positionPercent) : 50;
  const sliceCoord = -sliceAxisHalf + (2 * sliceAxisHalf) * (Math.min(100, Math.max(0, pct)) / 100);

  const vertices = new Float32Array(vertexCount * 2);
  const polygonOffsets = new Uint32Array(polygonCount + 1);
  const parentElementIds = new Uint32Array(polygonCount);
  const segments = new Float32Array(segmentCount * 4);
  const intersectionWorld = new Float32Array(vertexCount * 3);
  const intersectionEdgeNodeIds = new Uint32Array(vertexCount * 2);
  const intersectionEdgeT = new Float32Array(vertexCount);
  const intersectionKinds = new Uint32Array(vertexCount);

  const toWorld = (u, v) => {
    if (plane === "yz") return [sliceCoord, u, v];
    if (plane === "xz") return [u, sliceCoord, v];
    return [u, v, sliceCoord];
  };

  let vIdx = 0;
  let sIdx = 0;
  for (let r = 0; r < rows; r += 1) {
    const v0 = vMin + ((vMax - vMin) * r) / rows;
    const v1 = vMin + ((vMax - vMin) * (r + 1)) / rows;
    for (let c = 0; c < cols; c += 1) {
      const pIdx = r * cols + c;
      const u0 = uMin + ((uMax - uMin) * c) / cols;
      const u1 = uMin + ((uMax - uMin) * (c + 1)) / cols;
      polygonOffsets[pIdx] = vIdx;
      parentElementIds[pIdx] = pIdx * 3 + 1;

      const quad = [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ];
      for (let k = 0; k < 4; k += 1) {
        const [u, v] = quad[k];
        const [nx, ny] = quad[(k + 1) % 4];
        vertices[vIdx * 2] = u;
        vertices[vIdx * 2 + 1] = v;

        const [wx, wy, wz] = toWorld(u, v);
        intersectionWorld[vIdx * 3] = wx;
        intersectionWorld[vIdx * 3 + 1] = wy;
        intersectionWorld[vIdx * 3 + 2] = wz;

        intersectionEdgeNodeIds[vIdx * 2] = vIdx;
        intersectionEdgeNodeIds[vIdx * 2 + 1] = vIdx + 1;
        intersectionEdgeT[vIdx] = k % 2 === 0 ? 0.0 : 0.45;
        intersectionKinds[vIdx] = k % 2 === 0 ? 1 : 0;

        segments[sIdx * 4] = u;
        segments[sIdx * 4 + 1] = v;
        segments[sIdx * 4 + 2] = nx;
        segments[sIdx * 4 + 3] = ny;
        sIdx += 1;
        vIdx += 1;
      }
    }
  }
  polygonOffsets[polygonCount] = vIdx;

  const byteLen =
    FMCS_V2_HEADER_LEN +
    vertices.byteLength +
    polygonOffsets.byteLength +
    parentElementIds.byteLength +
    segments.byteLength +
    intersectionWorld.byteLength +
    intersectionEdgeNodeIds.byteLength +
    intersectionEdgeT.byteLength +
    intersectionKinds.byteLength;

  const buffer = new ArrayBuffer(byteLen);
  const view = new DataView(buffer);
  writeAscii(view, 0, "FMCS");
  view.setUint32(4, FMCS_VERSION_V2, true);
  view.setUint32(8, polygonCount, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, segmentCount, true);
  view.setUint32(20, polygonCount, true);
  view.setUint32(24, vertexCount, true);
  view.setUint32(28, FMCS_FLAG_INTERSECTION_METADATA, true);
  view.setFloat64(32, uMin, true);
  view.setFloat64(40, uMax, true);
  view.setFloat64(48, vMin, true);
  view.setFloat64(56, vMax, true);

  let offset = FMCS_V2_HEADER_LEN;
  new Float32Array(buffer, offset, vertices.length).set(vertices);
  offset += vertices.byteLength;
  new Uint32Array(buffer, offset, polygonOffsets.length).set(polygonOffsets);
  offset += polygonOffsets.byteLength;
  new Uint32Array(buffer, offset, parentElementIds.length).set(parentElementIds);
  offset += parentElementIds.byteLength;
  new Float32Array(buffer, offset, segments.length).set(segments);
  offset += segments.byteLength;
  new Float32Array(buffer, offset, intersectionWorld.length).set(intersectionWorld);
  offset += intersectionWorld.byteLength;
  new Uint32Array(buffer, offset, intersectionEdgeNodeIds.length).set(intersectionEdgeNodeIds);
  offset += intersectionEdgeNodeIds.byteLength;
  new Float32Array(buffer, offset, intersectionEdgeT.length).set(intersectionEdgeT);
  offset += intersectionEdgeT.byteLength;
  new Uint32Array(buffer, offset, intersectionKinds.length).set(intersectionKinds);

  return Buffer.from(buffer);
}

/**
 * Encodes an FMCS v4 exact planar mesh overlay buffer matching crossSectionCodec.test.ts.
 */
export function encodeFmcsV4({
  bounds,
  vertices,
  polygonOffsets,
  parentElementIds,
  segments,
  segmentKinds,
}) {
  const polygonCount = parentElementIds.length;
  const vertexCount = vertices.length / 2;
  const segmentCount = segmentKinds.length;

  const byteLen =
    FMCS_V4_HEADER_LEN +
    vertices.length * 4 +
    polygonOffsets.length * 4 +
    parentElementIds.length * 4 +
    segments.length * 4 +
    segmentKinds.length;

  const buffer = new ArrayBuffer(byteLen);
  const view = new DataView(buffer);
  writeAscii(view, 0, "FMCS");
  view.setUint32(4, FMCS_VERSION_V4, true);
  view.setUint32(8, polygonCount, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, segmentCount, true);
  view.setUint32(20, polygonCount, true);
  view.setUint32(24, segmentCount, true);
  view.setUint32(28, 2, true); // exact boundary classification
  view.setFloat64(32, bounds.uMin, true);
  view.setFloat64(40, bounds.uMax, true);
  view.setFloat64(48, bounds.vMin, true);
  view.setFloat64(56, bounds.vMax, true);

  let offset = FMCS_V4_HEADER_LEN;
  new Float32Array(buffer, offset, vertices.length).set(vertices);
  offset += vertices.length * 4;
  new Uint32Array(buffer, offset, polygonOffsets.length).set(polygonOffsets);
  offset += polygonOffsets.length * 4;
  new Uint32Array(buffer, offset, parentElementIds.length).set(parentElementIds);
  offset += parentElementIds.length * 4;
  new Float32Array(buffer, offset, segments.length).set(segments);
  offset += segments.length * 4;
  new Uint8Array(buffer, offset, segmentKinds.length).set(segmentKinds);

  return Buffer.from(buffer);
}

/**
 * Serves full or RFC 9110 Range-sliced binary payload for Playwright route fulfillment.
 */
export function binaryRangeFulfillOptions(buffer, rangeHeader, headers = {}) {
  const totalLength = buffer.byteLength;
  const baseHeaders = {
    "accept-ranges": "bytes",
    "content-type": "application/octet-stream",
    ...headers,
  };
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
    if (match) {
      const start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : totalLength - 1;
      const end = Math.min(Math.max(start, requestedEnd), totalLength - 1);
      if (start < totalLength && start <= end) {
        const slice = buffer.subarray(start, end + 1);
        return {
          status: 206,
          headers: {
            ...baseHeaders,
            "content-length": String(slice.byteLength),
            "content-range": `bytes ${start}-${end}/${totalLength}`,
          },
          body: slice,
        };
      }
    }
  }
  return {
    status: 200,
    headers: {
      ...baseHeaders,
      "content-length": String(totalLength),
    },
    body: buffer,
  };
}

export function encodeFmvpV3({
  quantityId = "m",
  grid,
  nComp = 3,
  data,
  domainGenerationId,
  meshTopologyHashHex,
  meshTopologyRevision = 1,
  scopeKind = "full",
  scopeId = "",
}) {
  const [gridX, gridY, gridZ] = grid;
  const expectedCount = gridX * gridY * gridZ * nComp;
  const cleanHex = String(meshTopologyHashHex).replace(/^sha256:/, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanHex)) {
    throw new Error(`encodeFmvpV3: expected 64-char hex meshTopologyHashHex, got "${meshTopologyHashHex}"`);
  }
  const enc = new TextEncoder();
  const scopeKindBytes = enc.encode(scopeKind);
  const scopeIdBytes = enc.encode(scopeId);
  const domGenBytes = enc.encode(domainGenerationId);
  const rawMetaLen = 68 + scopeKindBytes.length + scopeIdBytes.length + domGenBytes.length;
  const metadataLength = Math.ceil(rawMetaLen / 8) * 8;
  const valueOffset = 48 + metadataLength;
  const buffer = new ArrayBuffer(valueOffset + expectedCount * 8);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  writeAscii(view, 0, "FMVP");
  view.setUint8(4, 3);
  view.setUint8(5, 1); // KIND_F64
  view.setUint8(6, nComp);
  view.setUint8(7, 0);
  view.setUint32(8, metadataLength, true);
  view.setUint32(12, expectedCount, true);
  view.setUint32(16, gridX, true);
  view.setUint32(20, gridY, true);
  view.setUint32(24, gridZ, true);
  u8.set(enc.encode(quantityId).subarray(0, 16), 28);

  const ms = 48;
  writeAscii(view, ms, "FMMI");
  view.setUint16(ms + 4, 2, true); // SUPPORTED_METADATA_VERSION
  view.setUint16(ms + 6, 0, true);
  view.setUint16(ms + 8, domGenBytes.length, true);
  view.setBigUint64(ms + 16, BigInt(meshTopologyRevision), true);
  for (let i = 0; i < 32; i += 1) {
    u8[ms + 24 + i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  view.setUint32(ms + 56, 0, true); // full_domain
  view.setUint32(ms + 60, 0, true); // nodeIndexCount
  view.setUint16(ms + 64, scopeKindBytes.length, true);
  view.setUint16(ms + 66, scopeIdBytes.length, true);

  let strOffset = ms + 68;
  u8.set(scopeKindBytes, strOffset);
  strOffset += scopeKindBytes.length;
  u8.set(scopeIdBytes, strOffset);
  strOffset += scopeIdBytes.length;
  u8.set(domGenBytes, strOffset);

  new Float64Array(buffer, valueOffset, expectedCount).set(data);
  return Buffer.from(buffer);
}

function writeAscii(view, byteOffset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(byteOffset + i, text.charCodeAt(i));
  }
}
