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
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
