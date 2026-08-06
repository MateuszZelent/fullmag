import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "../apiTypes";

const MAGIC = "FMRM";
const LEGACY_VERSION = 1;
const LEGACY_KIND_U32 = 1;
const VERSION = 2;
const KIND_U32 = 2;
/** Canonical v2 value for a grid cell outside the realized active domain. */
export const FMRM_INACTIVE_REGION_ID = 0xffff_ffff;
export const FMRM_HEADER_LEN = 64;

/**
 * v1 encoded only numeric region IDs and had no active mask. A zero therefore
 * cannot be classified as active-unassigned versus inactive, so v1 is kept
 * for diagnostics but must not be used as a realized render mask.
 */
export type FdmRegionMembershipSemanticStatus =
  | "canonical"
  | "legacy-ambiguous";

export interface DecodedFdmRegionMembership {
  counts: [number, number, number];
  cellCount: number;
  legendCount: number;
  gridFingerprint: string;
  formatVersion: number;
  semanticStatus: FdmRegionMembershipSemanticStatus;
  payloadKind: number;
  regionIds: Uint32Array;
}

export type FdmRegionMembershipIncompatibilityReason =
  | "descriptor-encoding-mismatch"
  | "duplicate-legend-identity"
  | "duplicate-legend-id"
  | "domain-not-fdm"
  | "generation-mismatch"
  | "grid-cell-count-mismatch"
  | "grid-fingerprint-mismatch"
  | "grid-geometry-mismatch"
  | "grid-shape-mismatch"
  | "invalid-legend-identity"
  | "legend-count-mismatch"
  | "legend-fingerprint-invalid"
  | "legend-fingerprint-mismatch"
  | "legacy-ambiguous"
  | "noncontiguous-legend-id"
  | "reserved-legend-id"
  | "stale-descriptor"
  | "unknown-region-id";

export type FdmRegionMembershipContractResult =
  | {
      generationId: string;
      gridFingerprint: string;
      legendFingerprint: string | null;
      status: "ready";
    }
  | {
      reason: FdmRegionMembershipIncompatibilityReason;
      status: "incompatible";
    };

interface FdmRegionMembershipContractOptions {
  expectedGenerationId?: string | null;
  expectedGridFingerprint?: string | null;
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
    // Preserve v1 values verbatim. Without an active mask, zero is ambiguous
    // (inactive versus active-unassigned), so the caller can retain this
    // payload for diagnostics without treating it as a realized render mask.
    regionIds[index] = regionId;
  }
  return {
    counts,
    cellCount,
    formatVersion,
    gridFingerprint,
    legendCount,
    payloadKind,
    regionIds,
    semanticStatus: isCanonical ? "canonical" : "legacy-ambiguous",
  };
}

export async function validateFdmRegionMembershipContract(
  decoded: DecodedFdmRegionMembership,
  descriptor: FdmRegionMembershipResource,
  domain: DomainMetaResource,
  options: FdmRegionMembershipContractOptions = {},
): Promise<FdmRegionMembershipContractResult> {
  if (decoded.semanticStatus !== "canonical") {
    return { reason: "legacy-ambiguous", status: "incompatible" };
  }
  if (
    descriptor.schema_version !== "fdm_region_membership.v2" ||
    descriptor.encoding !== "FMRM:u32_membership_le" ||
    decoded.formatVersion !== VERSION ||
    decoded.payloadKind !== KIND_U32
  ) {
    return { reason: "descriptor-encoding-mismatch", status: "incompatible" };
  }
  if (descriptor.freshness.trim().toLowerCase() !== "current") {
    return { reason: "stale-descriptor", status: "incompatible" };
  }
  if (domain.discretization.trim().toLowerCase() !== "fdm" || !domain.grid) {
    return { reason: "domain-not-fdm", status: "incompatible" };
  }
  if (descriptor.domain_generation_id !== domain.generation_id) {
    return { reason: "generation-mismatch", status: "incompatible" };
  }
  if (
    options.expectedGenerationId != null &&
    options.expectedGenerationId !== domain.generation_id
  ) {
    return { reason: "generation-mismatch", status: "incompatible" };
  }
  if (
    options.expectedGridFingerprint != null &&
    options.expectedGridFingerprint !== descriptor.grid_fingerprint
  ) {
    return { reason: "grid-fingerprint-mismatch", status: "incompatible" };
  }
  if (decoded.gridFingerprint !== descriptor.grid_fingerprint) {
    return { reason: "grid-fingerprint-mismatch", status: "incompatible" };
  }
  if (!sameNumberTuple(decoded.counts, descriptor.counts)) {
    return { reason: "grid-shape-mismatch", status: "incompatible" };
  }
  if (!sameNumberTuple(descriptor.counts, domain.grid.shape)) {
    return { reason: "grid-shape-mismatch", status: "incompatible" };
  }
  if (
    decoded.cellCount !== descriptor.cell_count ||
    domain.counts.cells !== descriptor.cell_count
  ) {
    return { reason: "grid-cell-count-mismatch", status: "incompatible" };
  }
  if (
    !sameNumberTuple(descriptor.origin_m, domain.grid.origin) ||
    !sameNumberTuple(descriptor.cell_m, domain.grid.spacing)
  ) {
    return { reason: "grid-geometry-mismatch", status: "incompatible" };
  }
  if (decoded.legendCount !== descriptor.region_legend.length) {
    return { reason: "legend-count-mismatch", status: "incompatible" };
  }
  const legendIds = new Set<number>();
  const legendIdentities = new Set<string>();
  for (const [index, entry] of descriptor.region_legend.entries()) {
    if (
      entry.numeric_id === 0 ||
      entry.numeric_id === FMRM_INACTIVE_REGION_ID
    ) {
      return { reason: "reserved-legend-id", status: "incompatible" };
    }
    if (legendIds.has(entry.numeric_id)) {
      return { reason: "duplicate-legend-id", status: "incompatible" };
    }
    legendIds.add(entry.numeric_id);
    if (entry.numeric_id !== index + 1) {
      return { reason: "noncontiguous-legend-id", status: "incompatible" };
    }
    if (entry.object_id.length === 0 || entry.region_id.length === 0) {
      return { reason: "invalid-legend-identity", status: "incompatible" };
    }
    const semanticIdentity = JSON.stringify([entry.object_id, entry.region_id]);
    if (legendIdentities.has(semanticIdentity)) {
      return { reason: "duplicate-legend-identity", status: "incompatible" };
    }
    legendIdentities.add(semanticIdentity);
  }
  for (const regionId of decoded.regionIds) {
    if (
      regionId !== 0 &&
      regionId !== FMRM_INACTIVE_REGION_ID &&
      !legendIds.has(regionId)
    ) {
      return { reason: "unknown-region-id", status: "incompatible" };
    }
  }

  const legendFingerprint = descriptor.region_legend_fingerprint ?? null;
  if (legendFingerprint !== null) {
    const expectedFingerprint = normalizeSha256Fingerprint(legendFingerprint);
    if (expectedFingerprint === null) {
      return { reason: "legend-fingerprint-invalid", status: "incompatible" };
    }
    const actualFingerprint = await sha256Hex(canonicalLegendBytes(descriptor));
    if (actualFingerprint !== expectedFingerprint) {
      return { reason: "legend-fingerprint-mismatch", status: "incompatible" };
    }
  } else if (decoded.formatVersion >= VERSION && decoded.legendCount > 0) {
    return { reason: "legend-fingerprint-invalid", status: "incompatible" };
  }

  return {
    generationId: descriptor.domain_generation_id,
    gridFingerprint: descriptor.grid_fingerprint,
    legendFingerprint,
    status: "ready",
  };
}

function sameNumberTuple(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalLegendBytes(
  descriptor: FdmRegionMembershipResource,
): Uint8Array {
  const canonicalLegend = descriptor.region_legend.map((entry) => ({
    numeric_id: entry.numeric_id,
    object_id: entry.object_id,
    region_id: entry.region_id,
    priority: entry.priority,
  }));
  return new TextEncoder().encode(JSON.stringify(canonicalLegend));
}

function normalizeSha256Fingerprint(value: string): string | null {
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

async function sha256Hex(payload: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256FallbackHex(payload);
  const digest = await subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Keeps FMRM contract validation available on the HTTP Control Room origin. */
function sha256FallbackHex(payload: Uint8Array): string {
  const bitLength = payload.byteLength * 8;
  const paddedLength = Math.ceil((payload.byteLength + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(payload);
  bytes[payload.byteLength] = 0x80;
  const padding = new DataView(bytes.buffer);
  padding.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  padding.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  const rotateRight = (value: number, bits: number) =>
    (value >>> bits) | (value << (32 - bits));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = padding.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15] ?? 0;
      const previous2 = schedule[index - 2] ?? 0;
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      schedule[index] = (sigma1 + (schedule[index - 7] ?? 0) + sigma0 + (schedule[index - 16] ?? 0)) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  return [...hash]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
