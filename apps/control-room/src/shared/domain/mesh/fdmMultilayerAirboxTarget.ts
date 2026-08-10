import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";

export interface FdmMultilayerAirboxTarget {
  carrierFingerprint: string;
  cellSize: readonly [number, number, number];
  cells: readonly [number, number, number];
  origin: readonly [number, number, number];
  sampleCount: number;
  valueCount: number;
}

function tuple3PositiveIntegers(
  value: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!value || value.length !== 3 || value.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
    return null;
  }
  return [value[0]!, value[1]!, value[2]!];
}

function tuple3PositiveFinite(
  value: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!value || value.length !== 3 || value.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
    return null;
  }
  return [value[0]!, value[1]!, value[2]!];
}

function tuple3Finite(
  value: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!value || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
    return null;
  }
  return [value[0]!, value[1]!, value[2]!];
}

/**
 * Validates the target-only observation carrier before a consumer publishes
 * its geometry. The common FFT layout is deliberately absent from this model.
 */
export function resolveFdmMultilayerAirboxTarget(
  layout: FdmMultilayerLayoutResource | null | undefined,
): FdmMultilayerAirboxTarget | null {
  if (!layout?.available || !layout.airbox.carrier_available) return null;
  const domainGenerationId = safeNonEmptyDomainGenerationId(
    layout.domain_generation_id,
  );
  const airbox = layout.airbox;
  const cells = tuple3PositiveIntegers(airbox.cells);
  const cellSize = tuple3PositiveFinite(airbox.cell_size_m);
  const origin = tuple3Finite(airbox.origin_m);
  const carrierFingerprint =
    typeof airbox.carrier_fingerprint === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(airbox.carrier_fingerprint)
      ? airbox.carrier_fingerprint
      : null;
  const sampleCount = airbox.sample_count;
  const valueCount = airbox.value_count;
  const totalCells = cells ? cells[0] * cells[1] * cells[2] : 0;

  if (
    !cells ||
    !cellSize ||
    !origin ||
    !domainGenerationId ||
    !carrierFingerprint ||
    airbox.target_only !== true ||
    airbox.h_demag_available !== true ||
    airbox.h_eff_available !== false ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount !== totalCells ||
    !Number.isSafeInteger(valueCount) ||
    valueCount !== totalCells * 3
  ) {
    return null;
  }

  return {
    carrierFingerprint,
    cellSize,
    cells,
    origin,
    sampleCount,
    valueCount,
  };
}

/**
 * A target carrier must be bound to a concrete layout generation.  Keep this
 * validator independent from viewport modules while matching their
 * fail-closed treatment of malformed runtime payloads.
 */
function safeNonEmptyDomainGenerationId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }
  return value;
}
