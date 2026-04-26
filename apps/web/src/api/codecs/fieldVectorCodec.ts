/**
 * FMVP v2 binary field-vector codec.
 *
 * Wire format (little-endian):
 *   Offset  Size  Field
 *   ------  ----  -----
 *   0       4     magic "FMVP" (ASCII)
 *   4       1     version (2)
 *   5       1     kind (1 = float64)
 *   6       1     nComp
 *   7       1     reserved
 *   8       4     payloadId (uint32 LE)
 *   12      4     elementCount (uint32 LE)
 *   16      4     gridX (uint32 LE)
 *   20      4     gridY (uint32 LE)
 *   24      4     gridZ (uint32 LE)
 *   28      16    quantityId (null-padded ASCII)
 *   44      4     reserved
 *   48      ...   float64 values (elementCount * 8 bytes)
 */

import type { DecodedFieldVector } from "./types";

const MAGIC = "FMVP";
const HEADER_LEN = 48;
const KIND_F64 = 1;
const SUPPORTED_VERSION = 2;

export function decodeFieldVector(buffer: ArrayBuffer): DecodedFieldVector {
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMVP buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
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
    throw new Error(`Invalid FMVP magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint8(4);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMVP version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const kind = view.getUint8(5);
  if (kind !== KIND_F64) {
    throw new Error(`Unsupported FMVP value kind: expected ${KIND_F64}, got ${kind}`);
  }

  const nComp = view.getUint8(6);
  const elementCount = view.getUint32(12, true);
  const gridX = view.getUint32(16, true);
  const gridY = view.getUint32(20, true);
  const gridZ = view.getUint32(24, true);

  // Decode null-padded quantity ID (16 bytes at offset 28)
  const idBytes = new Uint8Array(buffer, 28, 16);
  let idEnd = idBytes.indexOf(0);
  if (idEnd === -1) idEnd = 16;
  const quantityId = new TextDecoder().decode(idBytes.subarray(0, idEnd));

  // Validate payload size
  const expectedLen = HEADER_LEN + elementCount * 8;
  if (buffer.byteLength !== expectedLen) {
    throw new Error(
      `FMVP buffer size mismatch: expected ${expectedLen}, got ${buffer.byteLength}`,
    );
  }

  // Zero-copy Float64Array view over the payload region
  const values = new Float64Array(buffer, HEADER_LEN, elementCount);

  const pointCount = gridX * gridY * gridZ;
  const expectedElementCount = pointCount * nComp;
  if (elementCount !== expectedElementCount) {
    throw new Error(
      `FMVP element count mismatch: expected grid*nComp=${expectedElementCount}, got ${elementCount}`,
    );
  }

  return {
    quantityId,
    nComp,
    grid: [gridX, gridY, gridZ],
    pointCount,
    valueCount: elementCount,
    dtype: "float64",
    values,
  };
}
