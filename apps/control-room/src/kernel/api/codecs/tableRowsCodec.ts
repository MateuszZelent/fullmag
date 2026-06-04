import type { DecodedTableRows } from "./types";

const HEADER_LEN = 60;
const MAGIC = "FMTB";
const SUPPORTED_VERSION = 1;

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

export function decodeTableRows(buffer: ArrayBuffer): DecodedTableRows {
  if (buffer.byteLength < HEADER_LEN) {
    throw new Error(
      `FMTB buffer too short: ${buffer.byteLength} bytes, need at least ${HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMTB magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint16(4, true);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMTB version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const flags = view.getUint16(6, true);
  const revision = Number(view.getBigUint64(8, true));
  const schemaRevision = Number(view.getBigUint64(16, true));
  const cursorStart = Number(view.getBigUint64(24, true));
  const cursorEnd = Number(view.getBigUint64(32, true));
  const totalRows = Number(view.getBigUint64(40, true));
  const rowCount = Number(view.getBigUint64(48, true));
  const columnCount = view.getUint32(56, true);
  const valueCount = rowCount * columnCount;
  const expectedLength = HEADER_LEN + valueCount * Float64Array.BYTES_PER_ELEMENT;

  if (!Number.isSafeInteger(valueCount)) {
    throw new Error(`FMTB value count is not safely representable: ${valueCount}`);
  }
  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `FMTB buffer size mismatch: expected ${expectedLength}, got ${buffer.byteLength}`,
    );
  }

  const values = new Float64Array(buffer.slice(HEADER_LEN));
  return {
    columnCount,
    cursorEnd,
    cursorStart,
    resyncRequired: (flags & 1) === 1,
    revision,
    rowCount,
    schemaRevision,
    totalRows,
    values,
  };
}
