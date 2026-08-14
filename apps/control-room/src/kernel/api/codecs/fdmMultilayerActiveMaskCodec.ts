import type { FdmMultilayerLayoutResource } from "../apiTypes";
import { sha256HexBytes } from "./fdmRegionMembershipCodec";

const MAGIC = "FMBM";
const VERSION = 1;
const KIND_BIT_PACKED_X_FASTEST = 1;
export const FMBM_HEADER_LEN = 104;

export interface DecodedFdmMultilayerActiveMask {
  activeMask: Uint8Array;
  cellCount: number;
  gridFingerprint: string;
  layoutRevision: number;
  maskHash: string;
  packedMask: Uint8Array;
  shape: [number, number, number];
}

export type FdmMultilayerActiveMaskContractResult =
  | { status: "ready" }
  | {
      reason:
        | "active-cell-count-mismatch"
        | "grid-fingerprint-mismatch"
        | "grid-shape-mismatch"
        | "layout-revision-mismatch"
        | "mask-hash-mismatch"
        | "mask-not-declared";
      status: "incompatible";
    };

export function decodeFdmMultilayerActiveMask(
  buffer: ArrayBuffer,
): DecodedFdmMultilayerActiveMask {
  if (buffer.byteLength < FMBM_HEADER_LEN) {
    throw new Error(
      `FMBM buffer too short: ${buffer.byteLength} bytes, need at least ${FMBM_HEADER_LEN}`,
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
    throw new Error(`Invalid FMBM magic: expected "${MAGIC}", got "${magic}"`);
  }
  if (
    view.getUint8(4) !== VERSION ||
    view.getUint8(5) !== KIND_BIT_PACKED_X_FASTEST
  ) {
    throw new Error("Unsupported FMBM version or payload kind");
  }
  const shape: [number, number, number] = [
    view.getUint32(8, true),
    view.getUint32(12, true),
    view.getUint32(16, true),
  ];
  const cellCount = view.getUint32(20, true);
  const packedLength = view.getUint32(24, true);
  const expectedCellCount = shape[0] * shape[1] * shape[2];
  if (
    !Number.isSafeInteger(expectedCellCount) ||
    expectedCellCount !== cellCount
  ) {
    throw new Error(
      `FMBM cell count mismatch: header ${cellCount}, grid ${expectedCellCount}`,
    );
  }
  const expectedPackedLength = Math.ceil(cellCount / 8);
  const expectedBufferLength = FMBM_HEADER_LEN + expectedPackedLength;
  if (
    packedLength !== expectedPackedLength ||
    buffer.byteLength !== expectedBufferLength
  ) {
    throw new Error(
      `FMBM payload size mismatch: expected ${expectedBufferLength}, got ${buffer.byteLength}`,
    );
  }
  // The v1 JSON layout schema exposes this unsigned 64-bit revision as a
  // number, so both transports intentionally use the same JavaScript rounding.
  // Exact carrier identity remains fail-closed through the grid fingerprint
  // and mask hash checks below.
  const layoutRevision = Number(view.getBigUint64(28, true));
  const gridFingerprint = hexBytes(buffer, 36, 32);
  const maskHash = hexBytes(buffer, 68, 32);
  const packedMask = new Uint8Array(buffer.slice(FMBM_HEADER_LEN));
  const activeMask = new Uint8Array(cellCount);
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    activeMask[cellIndex] =
      ((packedMask[cellIndex >> 3] ?? 0) >> (cellIndex & 7)) & 1;
  }
  return {
    activeMask,
    cellCount,
    gridFingerprint,
    layoutRevision,
    maskHash,
    packedMask,
    shape,
  };
}

export async function validateFdmMultilayerActiveMaskContract(
  decoded: DecodedFdmMultilayerActiveMask,
  layout: FdmMultilayerLayoutResource,
  layer: FdmMultilayerLayoutResource["layers"][number],
): Promise<FdmMultilayerActiveMaskContractResult> {
  if (
    !layer.active_mask_present ||
    !layer.mask_ref ||
    !layer.active_mask_hash
  ) {
    return { reason: "mask-not-declared", status: "incompatible" };
  }
  if (decoded.layoutRevision !== layout.layout_revision) {
    return { reason: "layout-revision-mismatch", status: "incompatible" };
  }
  if (!sameTuple(decoded.shape, layer.native_grid)) {
    return { reason: "grid-shape-mismatch", status: "incompatible" };
  }
  if (
    normalizeSha256(layer.native_grid_fingerprint) !== decoded.gridFingerprint
  ) {
    return { reason: "grid-fingerprint-mismatch", status: "incompatible" };
  }
  if (normalizeSha256(layer.active_mask_hash) !== decoded.maskHash) {
    return { reason: "mask-hash-mismatch", status: "incompatible" };
  }
  if ((await sha256HexBytes(decoded.packedMask)) !== decoded.maskHash) {
    return { reason: "mask-hash-mismatch", status: "incompatible" };
  }
  let activeCellCount = 0;
  for (const active of decoded.activeMask) activeCellCount += active;
  if (
    activeCellCount !== layer.active_cell_count ||
    decoded.cellCount - activeCellCount !== layer.inactive_cell_count
  ) {
    return { reason: "active-cell-count-mismatch", status: "incompatible" };
  }
  return { status: "ready" };
}

function hexBytes(buffer: ArrayBuffer, offset: number, length: number): string {
  return [...new Uint8Array(buffer, offset, length)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeSha256(value: string | null | undefined): string | null {
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value?.trim() ?? "");
  return match?.[1]?.toLowerCase() ?? null;
}

function sameTuple(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
