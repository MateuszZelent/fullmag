import type { DecodedFieldVector } from "./types";

const HEADER_LEN = 48;
const KIND_F64 = 1;
const MAGIC = "FMVP";
const SUPPORTED_VERSION = 2;

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

export function decodeFieldVector(buffer: ArrayBuffer): DecodedFieldVector {
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMVP buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);
  const magic = readMagic(view);
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
  if (nComp < 1 || nComp > 3) {
    throw new Error(`Unsupported FMVP component count: expected 1-3, got ${nComp}`);
  }

  const valueCount = view.getUint32(12, true);
  const gridX = view.getUint32(16, true);
  const gridY = view.getUint32(20, true);
  const gridZ = view.getUint32(24, true);
  const expectedLength = HEADER_LEN + valueCount * Float64Array.BYTES_PER_ELEMENT;

  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `FMVP buffer size mismatch: expected ${expectedLength}, got ${buffer.byteLength}`,
    );
  }

  const idBytes = new Uint8Array(buffer, 28, 16);
  let idEnd = idBytes.indexOf(0);
  if (idEnd === -1) {
    idEnd = idBytes.length;
  }

  const pointCount = gridX * gridY * gridZ;
  const expectedValueCount = pointCount * nComp;
  if (valueCount !== expectedValueCount) {
    throw new Error(
      `FMVP element count mismatch: expected grid*nComp=${expectedValueCount}, got ${valueCount}`,
    );
  }

  return {
    dtype: "float64",
    grid: [gridX, gridY, gridZ],
    nComp,
    pointCount,
    quantityId: new TextDecoder().decode(idBytes.subarray(0, idEnd)),
    valueCount,
    values: new Float64Array(buffer, HEADER_LEN, valueCount),
  };
}
