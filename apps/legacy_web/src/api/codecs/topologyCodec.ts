/**
 * FMMT v1 binary FEM topology codec.
 *
 * Wire format (little-endian):
 *   Offset  Size  Field
 *   ------  ----  -----
 *   0       4     magic "FMMT" (ASCII)
 *   4       1     version (1)
 *   5       3     reserved
 *   8       4     nodeCount (uint32 LE)
 *   12      4     elementCount (uint32 LE)
 *   16      4     boundaryFaceCount (uint32 LE)
 *   20      4     elementMarkerCount (uint32 LE)
 *   24      4     boundaryMarkerCount (uint32 LE)
 *   28      4     reserved
 *   32      ...   payload sections:
 *                 - nodes: nodeCount * 3 * float64
 *                 - elements: elementCount * 4 * uint32
 *                 - boundaryFaces: boundaryFaceCount * 3 * uint32
 *                 - elementMarkers: elementMarkerCount * uint32
 *                 - boundaryMarkers: boundaryMarkerCount * uint32
 */

import type { DecodedTopology } from "./types";

const MAGIC = "FMMT";
const HEADER_LEN = 32;
const SUPPORTED_VERSION = 1;

interface TopologyHeader {
  nodeCount: number;
  elementCount: number;
  boundaryFaceCount: number;
  elementMarkerCount: number;
  boundaryMarkerCount: number;
}

function expectedByteLength(h: TopologyHeader): number {
  return (
    HEADER_LEN +
    h.nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    h.elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    h.boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    h.elementMarkerCount * Uint32Array.BYTES_PER_ELEMENT +
    h.boundaryMarkerCount * Uint32Array.BYTES_PER_ELEMENT
  );
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
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMMT buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);

  // Validate magic
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMMT magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint8(4);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMMT version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const header: TopologyHeader = {
    nodeCount: view.getUint32(8, true),
    elementCount: view.getUint32(12, true),
    boundaryFaceCount: view.getUint32(16, true),
    elementMarkerCount: view.getUint32(20, true),
    boundaryMarkerCount: view.getUint32(24, true),
  };

  const expected = expectedByteLength(header);
  if (buffer.byteLength !== expected) {
    throw new Error(
      `FMMT buffer size mismatch: expected ${expected}, got ${buffer.byteLength}`,
    );
  }

  let offset = HEADER_LEN;

  // Nodes: nodeCount * 3 float64
  const nodesLen = header.nodeCount * 3;
  const positions = new Float64Array(buffer, offset, nodesLen);
  offset += nodesLen * Float64Array.BYTES_PER_ELEMENT;

  // Elements: elementCount * 4 uint32
  const elemLen = header.elementCount * 4;
  const indices = new Uint32Array(buffer, offset, elemLen);
  offset += elemLen * Uint32Array.BYTES_PER_ELEMENT;

  // Boundary faces: boundaryFaceCount * 3 uint32
  const bfLen = header.boundaryFaceCount * 3;
  const boundaryFaces = new Uint32Array(buffer, offset, bfLen);
  offset += bfLen * Uint32Array.BYTES_PER_ELEMENT;

  // Element markers
  const elementMarkers = new Uint32Array(buffer, offset, header.elementMarkerCount);
  offset += header.elementMarkerCount * Uint32Array.BYTES_PER_ELEMENT;

  // Boundary markers
  const boundaryMarkers = new Uint32Array(buffer, offset, header.boundaryMarkerCount);
  offset += header.boundaryMarkerCount * Uint32Array.BYTES_PER_ELEMENT;

  if (offset !== buffer.byteLength) {
    throw new Error("FMMT buffer has trailing bytes");
  }

  validateRanges(positions, indices, boundaryFaces, header.nodeCount);

  return {
    nodeCount: header.nodeCount,
    elementCount: header.elementCount,
    boundaryFaceCount: header.boundaryFaceCount,
    positions,
    indices,
    boundaryFaces,
    elementMarkers,
    boundaryMarkers,
  };
}
