const MAGIC = "FMRM";
const LEGACY_VERSION = 1;
const LEGACY_KIND_U32 = 1;
const VERSION = 2;
const KIND_U32 = 2;
/** Canonical v2 value for a grid cell outside the realized active domain. */
export const FMRM_INACTIVE_REGION_ID = 0xffff_ffff;
export const FMRM_HEADER_LEN = 64;

export interface DecodedFdmRegionMembership {
  counts: [number, number, number];
  cellCount: number;
  legendCount: number;
  gridFingerprint: string;
  formatVersion: number;
  payloadKind: number;
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
  const formatVersion = view.getUint8(4);
  const payloadKind = view.getUint8(5);
  const isLegacy =
    formatVersion === LEGACY_VERSION && payloadKind === LEGACY_KIND_U32;
  const isCanonical = formatVersion === VERSION && payloadKind === KIND_U32;
  if (!isLegacy && !isCanonical) {
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
    const regionId = view.getUint32(
      FMRM_HEADER_LEN + index * Uint32Array.BYTES_PER_ELEMENT,
      true,
    );
    // v1 used zero for an unoccupied cell. Normalize that legacy sentinel to
    // the v2 value so render-model consumers have one inactive-cell contract.
    regionIds[index] =
      isLegacy && regionId === 0 ? FMRM_INACTIVE_REGION_ID : regionId;
  }
  return {
    counts,
    cellCount,
    formatVersion,
    gridFingerprint,
    legendCount,
    payloadKind,
    regionIds,
  };
}
