/** Immutable FEM active-node support; distinct from frozen-spin constraints. */
export const SAVED_SUPPORT_HEADER_BYTES = 24;
export const MAX_SAVED_SUPPORT_BYTES = 1024 * 1024;
const MAX_U64 = BigInt("18446744073709551615");

export interface SavedSupportIdentity {
  nodeCount: string;
  byteLength: string;
  sha256: string;
}

export interface DecodedSavedSupport {
  nodeCount: number;
  /** LSB-first, canonical-node ordering. Padding bits are always zero. */
  bits: Uint8Array;
}

function counter(value: string): bigint {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Saved support counter must be a canonical decimal u64.");
  }
  const result = BigInt(value);
  if (result > MAX_U64) throw new Error("Saved support counter exceeds u64.");
  return result;
}

export function savedSupportByteLimit(expected: SavedSupportIdentity): number {
  const count = counter(expected.nodeCount);
  const length = counter(expected.byteLength);
  if (count === BigInt(0) || length > BigInt(MAX_SAVED_SUPPORT_BYTES) ||
      length !== BigInt(SAVED_SUPPORT_HEADER_BYTES) + (count + BigInt(7)) / BigInt(8) ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new Error("Saved support identity exceeds its bounded contract.");
  }
  return Number(length);
}

export async function decodeSavedSupport(
  buffer: ArrayBuffer,
  expected: SavedSupportIdentity,
  signal?: AbortSignal,
): Promise<DecodedSavedSupport> {
  signal?.throwIfAborted();
  if (buffer.byteLength !== savedSupportByteLimit(expected)) {
    throw new Error("FMSP body length differs from its pinned identity.");
  }
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "FMSP" ||
      view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0 ||
      view.getBigUint64(8, true) !== counter(expected.nodeCount) ||
      view.getBigUint64(16, true) !== BigInt(buffer.byteLength - SAVED_SUPPORT_HEADER_BYTES)) {
    throw new Error("Unsupported or mismatched FMSP header.");
  }
  const nodeCount = Number(counter(expected.nodeCount));
  const bits = new Uint8Array(buffer, SAVED_SUPPORT_HEADER_BYTES);
  const remainder = nodeCount % 8;
  if (remainder !== 0 && (bits[bits.length - 1]! & (0xff << remainder)) !== 0) {
    throw new Error("FMSP padding bits must be zero.");
  }
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  signal?.throwIfAborted();
  const actual = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expected.sha256) throw new Error("FMSP checksum differs from its pinned identity.");
  return { nodeCount, bits };
}

export function savedSupportNodeIsActive(support: DecodedSavedSupport, node: number): boolean {
  if (!Number.isSafeInteger(node) || node < 0 || node >= support.nodeCount) {
    throw new Error("Saved support node is outside its canonical range.");
  }
  return (support.bits[Math.floor(node / 8)]! & (1 << (node % 8))) !== 0;
}
