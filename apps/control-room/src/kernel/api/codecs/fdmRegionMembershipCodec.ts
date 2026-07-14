const MAGIC = "FMRM";
const VERSION = 1;
const KIND_U32 = 1;
export const FMRM_HEADER_LEN = 64;

export interface DecodedFdmRegionMembership {
  counts: [number, number, number];
  cellCount: number;
  legendCount: number;
  gridFingerprint: string;
  regionIds: Uint32Array;
}

export function decodeFdmRegionMembership(
  buffer: ArrayBuffer,
): DecodedFdmRegionMembership {
  if (buffer.byteLength < FMRM_HEADER_LEN) {
    throw new Error(
      `FMRM buffer too short: ${buffer.byteLength} bytes, need at least ${FMRM_HEADER_LEN}`,
    );
  }
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMRM magic: expected "${MAGIC}", got "${magic}"`);
  }
  if (view.getUint8(4) !== VERSION || view.getUint8(5) !== KIND_U32) {
    throw new Error("Unsupported FMRM version or payload kind");
  }
  const counts: [number, number, number] = [
    view.getUint32(8, true),
    view.getUint32(12, true),
    view.getUint32(16, true),
  ];
  const cellCount = view.getUint32(20, true);
  const legendCount = view.getUint32(24, true);
  const expectedCellCount = counts[0] * counts[1] * counts[2];
  if (!Number.isSafeInteger(expectedCellCount) || expectedCellCount !== cellCount) {
    throw new Error(
      `FMRM cell count mismatch: header ${cellCount}, grid ${expectedCellCount}`,
    );
  }
  const expectedLength = FMRM_HEADER_LEN + cellCount * Uint32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `FMRM buffer size mismatch: expected ${expectedLength}, got ${buffer.byteLength}`,
    );
  }
  const fingerprintBytes = new Uint8Array(buffer, 28, 32);
  const gridFingerprint = [...fingerprintBytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const regionIds = new Uint32Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    regionIds[index] = view.getUint32(
      FMRM_HEADER_LEN + index * Uint32Array.BYTES_PER_ELEMENT,
      true,
    );
  }
  return { counts, cellCount, legendCount, gridFingerprint, regionIds };
}
