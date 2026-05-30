import type { DecodedCrossSectionQuality } from "./types";

export const FMQS_HEADER_LEN = 20;

const MAGIC = "FMQS";
const SUPPORTED_VERSION = 1;

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

export function decodeCrossSectionQuality(
  buffer: ArrayBuffer,
): DecodedCrossSectionQuality {
  if (buffer.byteLength < FMQS_HEADER_LEN) {
    throw new Error(
      `FMQS buffer too short: ${buffer.byteLength} bytes, need at least ${FMQS_HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMQS magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint32(4, true);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMQS version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const valueCount = view.getUint32(8, true);
  const min = view.getFloat32(12, true);
  const max = view.getFloat32(16, true);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("FMQS quality range is not finite");
  }

  const expectedByteLength =
    FMQS_HEADER_LEN + valueCount * Float32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedByteLength) {
    throw new Error(
      `FMQS buffer size mismatch: expected ${expectedByteLength}, got ${buffer.byteLength}`,
    );
  }

  return {
    perElementQuality: new Float32Array(buffer, FMQS_HEADER_LEN, valueCount),
    range: { min, max },
  };
}
