import type { DecodedTopology } from "./types";

export const FMMT_HEADER_LEN = 32;
const KIND_F64_U32 = 1;
const MAGIC = "FMMT";
const SUPPORTED_VERSION = 1;

export interface TopologyHeader {
  boundaryFaceCount: number;
  boundaryMarkerCount: number;
  elementCount: number;
  elementMarkerCount: number;
  nodeCount: number;
}

export interface TopologyByteLayout {
  boundaryFaces: ByteRange;
  boundaryMarkers: ByteRange;
  elementMarkers: ByteRange;
  expectedByteLength: number;
  indices: ByteRange;
  positions: ByteRange;
}

export interface TopologySections {
  boundaryFaces: Uint32Array;
  boundaryMarkers: Uint32Array;
  elementMarkers: Uint32Array;
  indices: Uint32Array;
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

export function expectedTopologyByteLength(header: TopologyHeader): number {
  return (
    FMMT_HEADER_LEN +
    header.nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    header.elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    header.boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    header.elementMarkerCount * Uint32Array.BYTES_PER_ELEMENT +
    header.boundaryMarkerCount * Uint32Array.BYTES_PER_ELEMENT
  );
}

export function topologyByteLayout(header: TopologyHeader): TopologyByteLayout {
  let offset = FMMT_HEADER_LEN;
  const positions = byteRange(offset, header.nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT);
  offset = positions.end + 1;
  const indices = byteRange(offset, header.elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT);
  offset = indices.end + 1;
  const boundaryFaces = byteRange(
    offset,
    header.boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT,
  );
  offset = boundaryFaces.end + 1;
  const elementMarkers = byteRange(
    offset,
    header.elementMarkerCount * Uint32Array.BYTES_PER_ELEMENT,
  );
  offset = elementMarkers.end + 1;
  const boundaryMarkers = byteRange(
    offset,
    header.boundaryMarkerCount * Uint32Array.BYTES_PER_ELEMENT,
  );
  return {
    boundaryFaces,
    boundaryMarkers,
    elementMarkers,
    expectedByteLength: boundaryMarkers.end + 1,
    indices,
    positions,
  };
}

function validateRanges(
  positions: Float64Array,
  indices: Uint32Array,
  boundaryFaces: Uint32Array,
  nodeCount: number,
): void {
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      throw new Error(`FMMT: non-finite node coordinate at index ${i}`);
    }
  }

  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= nodeCount) {
      throw new Error(`FMMT: element node index out of range at ${i}`);
    }
  }

  for (let i = 0; i < boundaryFaces.length; i++) {
    if (boundaryFaces[i] >= nodeCount) {
      throw new Error(`FMMT: boundary face node index out of range at ${i}`);
    }
  }
}

export function decodeTopology(buffer: ArrayBuffer): DecodedTopology {
  if (buffer.byteLength < FMMT_HEADER_LEN) {
    throw new Error(
      `FMMT buffer too short: ${buffer.byteLength} bytes, need at least ${FMMT_HEADER_LEN}`,
    );
  }

  const header = decodeTopologyHeader(buffer);
  const expected = expectedTopologyByteLength(header);
  if (buffer.byteLength !== expected) {
    throw new Error(
      `FMMT buffer size mismatch: expected ${expected}, got ${buffer.byteLength}`,
    );
  }

  let offset = FMMT_HEADER_LEN;
  const positions = new Float64Array(buffer, offset, header.nodeCount * 3);
  offset += positions.byteLength;
  const indices = new Uint32Array(buffer, offset, header.elementCount * 4);
  offset += indices.byteLength;
  const boundaryFaces = new Uint32Array(
    buffer,
    offset,
    header.boundaryFaceCount * 3,
  );
  offset += boundaryFaces.byteLength;
  const elementMarkers = new Uint32Array(
    buffer,
    offset,
    header.elementMarkerCount,
  );
  offset += elementMarkers.byteLength;
  const boundaryMarkers = new Uint32Array(
    buffer,
    offset,
    header.boundaryMarkerCount,
  );
  offset += boundaryMarkers.byteLength;

  if (offset !== buffer.byteLength) {
    throw new Error("FMMT buffer has trailing bytes");
  }

  return decodeTopologySections(header, {
    boundaryFaces,
    boundaryMarkers,
    elementMarkers,
    indices,
    positions,
  });
}

export function decodeTopologyHeader(buffer: ArrayBuffer): TopologyHeader {
  if (buffer.byteLength < FMMT_HEADER_LEN) {
    throw new Error(
      `FMMT buffer too short: ${buffer.byteLength} bytes, need at least ${FMMT_HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer, 0, FMMT_HEADER_LEN);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMMT magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint8(4);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMMT version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const kind = view.getUint8(5);
  if (kind !== KIND_F64_U32) {
    throw new Error(
      `Unsupported FMMT topology kind: expected ${KIND_F64_U32}, got ${kind}`,
    );
  }

  return {
    boundaryFaceCount: view.getUint32(16, true),
    boundaryMarkerCount: view.getUint32(24, true),
    elementCount: view.getUint32(12, true),
    elementMarkerCount: view.getUint32(20, true),
    nodeCount: view.getUint32(8, true),
  };
}

export function decodeTopologySections(
  header: TopologyHeader,
  sections: TopologySections,
): DecodedTopology {
  validateRanges(
    sections.positions,
    sections.indices,
    sections.boundaryFaces,
    header.nodeCount,
  );

  return {
    boundaryFaceCount: header.boundaryFaceCount,
    boundaryFaces: sections.boundaryFaces,
    boundaryMarkers: sections.boundaryMarkers,
    elementCount: header.elementCount,
    elementMarkers: sections.elementMarkers,
    indices: sections.indices,
    nodeCount: header.nodeCount,
    positions: sections.positions,
  };
}

function byteRange(start: number, byteLength: number): ByteRange {
  return {
    end: start + Math.max(byteLength, 0) - 1,
    start,
  };
}
