import type { ScalarRow } from "../session/types";

const CSV_HEADER = [
  "step",
  "time",
  "solver_dt",
  "mx",
  "my",
  "mz",
  "E_ex",
  "E_demag",
  "E_ext",
  "E_ani",
  "E_dmi",
  "E_total",
  "max_dm_dt",
  "max_h_eff",
  "max_h_demag",
  "max_torque_Apm",
  "max_torque_T",
] as const;

function asNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * CH-001 fix: coerce optional fields — returns undefined when the
 * source value is absent, null, or not a finite number, so that
 * downstream consumers (ScalarPlot, columnHasData) can distinguish
 * "missing" from "zero".
 */
function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function coerceScalarRow(raw: unknown): ScalarRow {
  const row =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};

  return {
    step: asNumber(row.step),
    time: asNumber(row.time),
    solver_dt: asNumber(row.solver_dt ?? row.dt),
    mx: asNumber(row.mx),
    my: asNumber(row.my),
    mz: asNumber(row.mz),
    e_ex: asNumber(row.e_ex),
    e_demag: asNumber(row.e_demag),
    e_ext: asNumber(row.e_ext),
    e_ani: asNumber(row.e_ani),
    e_dmi: asNumber(row.e_dmi),
    e_total: asNumber(row.e_total),
    max_dm_dt: asNumber(row.max_dm_dt),
    max_h_eff: asNumber(row.max_h_eff),
    max_h_demag: asNumber(row.max_h_demag),
    max_torque_Apm: asOptionalNumber(row.max_torque_Apm),
    max_torque_T: asOptionalNumber(row.max_torque_T),
  };
}

export function coerceScalarRows(raw: unknown): ScalarRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(coerceScalarRow);
}

function fingerprintNumber(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(12) : "0";
}

export function scalarRowsTipFingerprint(rows: ScalarRow[]): string {
  if (rows.length === 0) {
    return "0:-1";
  }
  const last = rows[rows.length - 1]!;
  return [
    rows.length,
    last.step,
    fingerprintNumber(last.time),
    fingerprintNumber(last.solver_dt),
    fingerprintNumber(last.e_total),
    fingerprintNumber(last.max_dm_dt),
    fingerprintNumber(last.max_h_eff),
  ].join(":");
}

function csvNumber(value: number): string {
  return Number.isFinite(value) ? value.toExponential(15) : "0.000000000000000e+00";
}

export function serializeScalarRowsCsv(rows: ScalarRow[]): string {
  const lines = rows.map((row) => [
    row.step.toString(),
    csvNumber(row.time),
    csvNumber(row.solver_dt),
    csvNumber(row.mx),
    csvNumber(row.my),
    csvNumber(row.mz),
    csvNumber(row.e_ex),
    csvNumber(row.e_demag),
    csvNumber(row.e_ext),
    csvNumber(row.e_ani),
    csvNumber(row.e_dmi),
    csvNumber(row.e_total),
    csvNumber(row.max_dm_dt),
    csvNumber(row.max_h_eff),
    csvNumber(row.max_h_demag),
    csvNumber(row.max_torque_Apm ?? 0),
    csvNumber(row.max_torque_T ?? 0),
  ].join(","));

  return [CSV_HEADER.join(","), ...lines].join("\n");
}
