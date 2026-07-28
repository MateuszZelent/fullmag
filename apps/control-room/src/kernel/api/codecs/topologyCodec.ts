import type { DecodedTopology } from "./types";

export const FMMT_V1_HEADER_LEN = 32;
export const FMMT_V2_HEADER_LEN = 64;
/** Initial range size large enough to decode either supported header. */
export const FMMT_HEADER_LEN = FMMT_V2_HEADER_LEN;

const KIND_F64_U32 = 1;
const MAGIC = "FMMT";
const MAX_TYPED_ARRAY_ELEMENTS = 0xffff_ffff;

export interface TopologyHeader {
  boundaryFaceCount: number;
  boundaryMarkerCount: number;
  cellConnectivityCount: number;
  cellCount: number;
  cellMarkerCount: number;
  elementCount: number;
  elementMarkerCount: number;
  facetConnectivityCount: number;
  facetCount: number;
  facetMarkerCount: number;
  headerLength: number;
  nodeCount: number;
  version: 1 | 2;
}

export interface TopologyByteLayout {
  boundaryFaces: ByteRange;
  boundaryMarkers: ByteRange;
  cellMarkers: ByteRange;
  cellNodes: ByteRange;
  cellOffsets: ByteRange | null;
  cellTypes: ByteRange | null;
  elementMarkers: ByteRange;
  expectedByteLength: number;
  facetMarkers: ByteRange;
  facetNodes: ByteRange;
  facetOffsets: ByteRange | null;
  facetRoles: ByteRange | null;
  facetTypes: ByteRange | null;
  indices: ByteRange;
  positions: ByteRange;
}

export interface TopologySections {
  cellMarkers: Uint32Array;
  cellNodes: Uint32Array;
  cellOffsets: Uint32Array;
  cellTypes: Uint32Array;
  facetMarkers: Uint32Array;
  facetNodes: Uint32Array;
  facetOffsets: Uint32Array;
  facetRoles: Uint32Array;
  facetTypes: Uint32Array;
  positions: Float64Array;
}

interface ByteRange {
  end: number;
  start: number;
}

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

function checkedElementCount(
  label: string,
  count: number,
  multiplier = 1,
  extra = 0,
): number {
  const result = count * multiplier + extra;
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_TYPED_ARRAY_ELEMENTS) {
    throw new Error(`FMMT ${label} length overflow`);
  }
  return result;
}

function checkedByteLength(label: string, count: number, bytesPerElement: number): number {
  const result = count * bytesPerElement;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`FMMT ${label} byte length overflow`);
  }
  return result;
}

function checkedAdd(label: string, left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`FMMT ${label} offset overflow`);
  }
  return result;
}

function alignToEight(value: number): number {
  return checkedAdd("section alignment", value, (8 - (value % 8)) % 8);
}

function sectionRange(
  offset: number,
  elementCount: number,
  bytesPerElement: number,
  label: string,
): { next: number; range: ByteRange } {
  if (offset % 8 !== 0) {
    throw new Error(`FMMT ${label} section is misaligned at byte ${offset}`);
  }
  const byteLength = checkedByteLength(label, elementCount, bytesPerElement);
  const endExclusive = checkedAdd(label, offset, byteLength);
  return {
    next: alignToEight(endExclusive),
    range: byteRange(offset, byteLength),
  };
}

export function expectedTopologyByteLength(header: TopologyHeader): number {
  return topologyByteLayout(header).expectedByteLength;
}

export function topologyByteLayout(header: TopologyHeader): TopologyByteLayout {
  const positionCount = checkedElementCount("positions", header.nodeCount, 3);
  const cellOffsetCount = checkedElementCount("cell offsets", header.cellCount, 1, 1);
  const facetOffsetCount = checkedElementCount("facet offsets", header.facetCount, 1, 1);

  if (header.version === 1) {
    let offset = FMMT_V1_HEADER_LEN;
    const positions = byteRange(
      offset,
      checkedByteLength("positions", positionCount, Float64Array.BYTES_PER_ELEMENT),
    );
    offset = checkedAdd("positions", offset, byteLength(positions));
    const cellNodes = byteRange(
      offset,
      checkedByteLength(
        "cell connectivity",
        header.cellConnectivityCount,
        Uint32Array.BYTES_PER_ELEMENT,
      ),
    );
    offset = checkedAdd("cell connectivity", offset, byteLength(cellNodes));
    const facetNodes = byteRange(
      offset,
      checkedByteLength(
        "facet connectivity",
        header.facetConnectivityCount,
        Uint32Array.BYTES_PER_ELEMENT,
      ),
    );
    offset = checkedAdd("facet connectivity", offset, byteLength(facetNodes));
    const cellMarkers = byteRange(
      offset,
      checkedByteLength(
        "cell markers",
        header.cellMarkerCount,
        Uint32Array.BYTES_PER_ELEMENT,
      ),
    );
    offset = checkedAdd("cell markers", offset, byteLength(cellMarkers));
    const facetMarkers = byteRange(
      offset,
      checkedByteLength(
        "facet markers",
        header.facetMarkerCount,
        Uint32Array.BYTES_PER_ELEMENT,
      ),
    );
    const expectedByteLength = checkedAdd(
      "payload",
      facetMarkers.start,
      byteLength(facetMarkers),
    );
    return {
      boundaryFaces: facetNodes,
      boundaryMarkers: facetMarkers,
      cellMarkers,
      cellNodes,
      cellOffsets: null,
      cellTypes: null,
      elementMarkers: cellMarkers,
      expectedByteLength,
      facetMarkers,
      facetNodes,
      facetOffsets: null,
      facetRoles: null,
      facetTypes: null,
      indices: cellNodes,
      positions,
    };
  }

  let offset = header.headerLength;
  const positionsSection = sectionRange(offset, positionCount, 8, "positions");
  offset = positionsSection.next;
  const cellTypesSection = sectionRange(offset, header.cellCount, 4, "cell types");
  offset = cellTypesSection.next;
  const cellOffsetsSection = sectionRange(offset, cellOffsetCount, 4, "cell offsets");
  offset = cellOffsetsSection.next;
  const cellNodesSection = sectionRange(
    offset,
    header.cellConnectivityCount,
    4,
    "cell connectivity",
  );
  offset = cellNodesSection.next;
  const facetTypesSection = sectionRange(offset, header.facetCount, 4, "facet types");
  offset = facetTypesSection.next;
  const facetRolesSection = sectionRange(offset, header.facetCount, 4, "facet roles");
  offset = facetRolesSection.next;
  const facetOffsetsSection = sectionRange(offset, facetOffsetCount, 4, "facet offsets");
  offset = facetOffsetsSection.next;
  const facetNodesSection = sectionRange(
    offset,
    header.facetConnectivityCount,
    4,
    "facet connectivity",
  );
  offset = facetNodesSection.next;
  const cellMarkersSection = sectionRange(offset, header.cellMarkerCount, 4, "cell markers");
  offset = cellMarkersSection.next;
  const facetMarkersSection = sectionRange(offset, header.facetMarkerCount, 4, "facet markers");
  const expectedByteLength = checkedAdd(
    "payload",
    facetMarkersSection.range.start,
    byteLength(facetMarkersSection.range),
  );

  return {
    boundaryFaces: facetNodesSection.range,
    boundaryMarkers: facetMarkersSection.range,
    cellMarkers: cellMarkersSection.range,
    cellNodes: cellNodesSection.range,
    cellOffsets: cellOffsetsSection.range,
    cellTypes: cellTypesSection.range,
    elementMarkers: cellMarkersSection.range,
    expectedByteLength,
    facetMarkers: facetMarkersSection.range,
    facetNodes: facetNodesSection.range,
    facetOffsets: facetOffsetsSection.range,
    facetRoles: facetRolesSection.range,
    facetTypes: facetTypesSection.range,
    indices: cellNodesSection.range,
    positions: positionsSection.range,
  };
}

function validateNodeRanges(
  positions: Float64Array,
  cellNodes: Uint32Array,
  facetNodes: Uint32Array,
  nodeCount: number,
): void {
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      throw new Error(`FMMT: non-finite node coordinate at index ${i}`);
    }
  }
  for (let i = 0; i < cellNodes.length; i++) {
    if (cellNodes[i] >= nodeCount) {
      throw new Error(`FMMT: cell node index out of range at ${i}`);
    }
  }
  for (let i = 0; i < facetNodes.length; i++) {
    if (facetNodes[i] >= nodeCount) {
      throw new Error(`FMMT: facet node index out of range at ${i}`);
    }
  }
}

function validateCodes(values: Uint32Array, allowed: ReadonlySet<number>, label: string): void {
  for (let i = 0; i < values.length; i++) {
    if (!allowed.has(values[i])) {
      throw new Error(`FMMT: unknown ${label} ${values[i]} at index ${i}`);
    }
  }
}

function validateCsr(
  offsets: Uint32Array,
  nodes: Uint32Array,
  types: Uint32Array,
  arities: ReadonlyMap<number, number>,
  label: string,
): void {
  if (offsets.length !== types.length + 1 || offsets[0] !== 0) {
    throw new Error(`FMMT: invalid ${label} CSR offsets`);
  }
  for (let index = 0; index < types.length; index++) {
    const start = offsets[index];
    const end = offsets[index + 1];
    if (end < start || end - start !== arities.get(types[index])) {
      throw new Error(`FMMT: invalid ${label} CSR span at index ${index}`);
    }
  }
  if (offsets[offsets.length - 1] !== nodes.length) {
    throw new Error(`FMMT: ${label} CSR terminal offset does not match connectivity`);
  }
}

function sequentialOffsets(count: number, arity: number): Uint32Array {
  const offsets = new Uint32Array(count + 1);
  for (let index = 0; index <= count; index++) offsets[index] = index * arity;
  return offsets;
}

export function decodeTopology(buffer: ArrayBuffer): DecodedTopology {
  const header = decodeTopologyHeader(buffer);
  const layout = topologyByteLayout(header);
  if (buffer.byteLength !== layout.expectedByteLength) {
    throw new Error(
      `FMMT buffer size mismatch: expected ${layout.expectedByteLength}, got ${buffer.byteLength}`,
    );
  }

  const positions = float64View(buffer, layout.positions, header.nodeCount * 3);
  const cellNodes = uint32View(buffer, layout.cellNodes, header.cellConnectivityCount);
  const facetNodes = uint32View(buffer, layout.facetNodes, header.facetConnectivityCount);
  const cellMarkers = uint32View(buffer, layout.cellMarkers, header.cellMarkerCount);
  const facetMarkers = uint32View(buffer, layout.facetMarkers, header.facetMarkerCount);
  const cellTypes = layout.cellTypes
    ? uint32View(buffer, layout.cellTypes, header.cellCount)
    : new Uint32Array(header.cellCount).fill(1);
  const cellOffsets = layout.cellOffsets
    ? uint32View(buffer, layout.cellOffsets, header.cellCount + 1)
    : sequentialOffsets(header.cellCount, 4);
  const facetTypes = layout.facetTypes
    ? uint32View(buffer, layout.facetTypes, header.facetCount)
    : new Uint32Array(header.facetCount).fill(1);
  const facetRoles = layout.facetRoles
    ? uint32View(buffer, layout.facetRoles, header.facetCount)
    : new Uint32Array(header.facetCount).fill(1);
  const facetOffsets = layout.facetOffsets
    ? uint32View(buffer, layout.facetOffsets, header.facetCount + 1)
    : sequentialOffsets(header.facetCount, 3);

  return decodeTopologySections(header, {
    cellMarkers,
    cellNodes,
    cellOffsets,
    cellTypes,
    facetMarkers,
    facetNodes,
    facetOffsets,
    facetRoles,
    facetTypes,
    positions,
  });
}

export function decodeTopologyHeader(buffer: ArrayBuffer): TopologyHeader {
  if (buffer.byteLength < FMMT_V1_HEADER_LEN) {
    throw new Error(
      `FMMT buffer too short: ${buffer.byteLength} bytes, need at least ${FMMT_V1_HEADER_LEN}`,
    );
  }
  const view = new DataView(buffer);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMMT magic: expected "${MAGIC}", got "${magic}"`);
  }
  const version = view.getUint8(4);
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported FMMT version: expected 1 or 2, got ${version}`);
  }
  const kind = view.getUint8(5);
  if (kind !== KIND_F64_U32) {
    throw new Error(`Unsupported FMMT topology kind: expected ${KIND_F64_U32}, got ${kind}`);
  }

  if (version === 1) {
    const nodeCount = view.getUint32(8, true);
    const cellCount = view.getUint32(12, true);
    const facetCount = view.getUint32(16, true);
    const cellMarkerCount = view.getUint32(20, true);
    const facetMarkerCount = view.getUint32(24, true);
    return {
      boundaryFaceCount: facetCount,
      boundaryMarkerCount: facetMarkerCount,
      cellConnectivityCount: checkedElementCount("cell connectivity", cellCount, 4),
      cellCount,
      cellMarkerCount,
      elementCount: cellCount,
      elementMarkerCount: cellMarkerCount,
      facetConnectivityCount: checkedElementCount("facet connectivity", facetCount, 3),
      facetCount,
      facetMarkerCount,
      headerLength: FMMT_V1_HEADER_LEN,
      nodeCount,
      version,
    };
  }

  if (buffer.byteLength < FMMT_V2_HEADER_LEN) {
    throw new Error(
      `FMMT v2 buffer too short: ${buffer.byteLength} bytes, need at least ${FMMT_V2_HEADER_LEN}`,
    );
  }
  const headerLength = view.getUint32(36, true);
  if (headerLength !== FMMT_V2_HEADER_LEN || headerLength % 8 !== 0) {
    throw new Error(
      `FMMT v2 header length must be ${FMMT_V2_HEADER_LEN} and 8-byte aligned, got ${headerLength}`,
    );
  }
  const nodeCount = view.getUint32(8, true);
  const cellCount = view.getUint32(12, true);
  const facetCount = view.getUint32(16, true);
  const cellConnectivityCount = view.getUint32(20, true);
  const facetConnectivityCount = view.getUint32(24, true);
  const cellMarkerCount = view.getUint32(28, true);
  const facetMarkerCount = view.getUint32(32, true);
  if (
    (cellMarkerCount !== 0 && cellMarkerCount !== cellCount) ||
    (facetMarkerCount !== 0 && facetMarkerCount !== facetCount)
  ) {
    throw new Error("FMMT v2 marker counts must be zero or match cell and facet counts");
  }
  return {
    boundaryFaceCount: facetCount,
    boundaryMarkerCount: facetMarkerCount,
    cellConnectivityCount,
    cellCount,
    cellMarkerCount,
    elementCount: cellCount,
    elementMarkerCount: cellMarkerCount,
    facetConnectivityCount,
    facetCount,
    facetMarkerCount,
    headerLength,
    nodeCount,
    version,
  };
}

export function decodeTopologySections(
  header: TopologyHeader,
  sections: TopologySections,
): DecodedTopology {
  if (
    sections.positions.length !== header.nodeCount * 3 ||
    sections.cellTypes.length !== header.cellCount ||
    sections.cellOffsets.length !== header.cellCount + 1 ||
    sections.cellNodes.length !== header.cellConnectivityCount ||
    sections.facetTypes.length !== header.facetCount ||
    sections.facetRoles.length !== header.facetCount ||
    sections.facetOffsets.length !== header.facetCount + 1 ||
    sections.facetNodes.length !== header.facetConnectivityCount ||
    sections.cellMarkers.length !== header.cellMarkerCount ||
    sections.facetMarkers.length !== header.facetMarkerCount
  ) {
    throw new Error("FMMT decoded section length does not match header");
  }
  validateCodes(sections.cellTypes, new Set([1, 2, 3, 4]), "cell type code");
  validateCodes(sections.facetTypes, new Set([1, 2]), "facet type code");
  validateCodes(sections.facetRoles, new Set([1, 2, 3]), "facet role code");
  validateCsr(
    sections.cellOffsets,
    sections.cellNodes,
    sections.cellTypes,
    new Map([
      [1, 4],
      [2, 6],
      [3, 5],
      [4, 8],
    ]),
    "cell",
  );
  validateCsr(
    sections.facetOffsets,
    sections.facetNodes,
    sections.facetTypes,
    new Map([
      [1, 3],
      [2, 4],
    ]),
    "facet",
  );
  validateNodeRanges(
    sections.positions,
    sections.cellNodes,
    sections.facetNodes,
    header.nodeCount,
  );

  const legacyCellsRepresentable = sections.cellTypes.every((code) => code === 1);
  const legacyFacetsRepresentable = sections.facetTypes.every((code) => code === 1);
  const legacyCellNodes = legacyCellsRepresentable
    ? sections.cellNodes
    : new Uint32Array(0);
  const legacyFacetNodes = legacyFacetsRepresentable
    ? sections.facetNodes
    : new Uint32Array(0);

  return {
    boundaryFaceCount: header.facetCount,
    boundaryFaces: legacyFacetNodes,
    boundaryMarkers: sections.facetMarkers,
    cellCount: header.cellCount,
    cellMarkers: sections.cellMarkers,
    cellNodes: sections.cellNodes,
    cellOffsets: sections.cellOffsets,
    cellTypes: sections.cellTypes,
    elementCount: header.cellCount,
    elementMarkers: sections.cellMarkers,
    facetCount: header.facetCount,
    facetMarkers: sections.facetMarkers,
    facetNodes: sections.facetNodes,
    facetOffsets: sections.facetOffsets,
    facetRoles: sections.facetRoles,
    facetTypes: sections.facetTypes,
    formatVersion: header.version,
    indices: legacyCellNodes,
    nodeCount: header.nodeCount,
    positions: sections.positions,
  };
}

function byteRange(start: number, length: number): ByteRange {
  return { end: start + Math.max(length, 0) - 1, start };
}

function byteLength(range: ByteRange): number {
  return Math.max(0, range.end - range.start + 1);
}

function float64View(buffer: ArrayBuffer, range: ByteRange, length: number): Float64Array {
  if (length === 0) return new Float64Array(0);
  return new Float64Array(buffer, range.start, length);
}

function uint32View(buffer: ArrayBuffer, range: ByteRange, length: number): Uint32Array {
  if (length === 0) return new Uint32Array(0);
  return new Uint32Array(buffer, range.start, length);
}
