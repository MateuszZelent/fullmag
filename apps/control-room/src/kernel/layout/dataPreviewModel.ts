import type { DecodedFieldVector } from "@/kernel/api/codecs";

export interface DataPreviewRow {
  index: number;
  sourceIndex: number;
  values: string[];
}

export interface DataPreviewStepSignatureInput {
  last_step_updated_at_unix_ms?: number | null;
  revision?: number | string | null;
  runtime_state?: string | null;
  sim_time_seconds?: number | null;
  step_index?: number | null;
}

const DEFAULT_SAMPLE_COUNT = 17;
const MAX_SAMPLE_COUNT = 64;

export function normalizeDataPreviewSampleCount(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SAMPLE_COUNT;
  return Math.min(MAX_SAMPLE_COUNT, Math.max(1, Math.trunc(parsed)));
}

export function buildDataPreviewRows(
  fieldVector: DecodedFieldVector | null,
  sampleCount: number,
): DataPreviewRow[] {
  if (!fieldVector || fieldVector.pointCount <= 0) return [];
  const count = Math.min(
    normalizeDataPreviewSampleCount(sampleCount),
    fieldVector.pointCount,
  );
  const rows: DataPreviewRow[] = [];
  for (const sourceIndex of centerBiasedSourceIndices(
    fieldVector.pointCount,
    count,
  )) {
    const offset = sourceIndex * fieldVector.nComp;
    if (isZeroPoint(fieldVector, offset)) continue;
    const values: string[] = [];
    for (let component = 0; component < fieldVector.nComp; component += 1) {
      values.push(
        formatPreviewNumber(fieldVector.values[offset + component] ?? 0),
      );
    }
    rows.push({ index: rows.length, sourceIndex, values });
    if (rows.length >= count) break;
  }
  return rows;
}

export function buildDataPreviewSignature(
  fieldVector: DecodedFieldVector | null,
  sampleCount: number,
): string {
  const rows = buildDataPreviewRows(fieldVector, sampleCount);
  let hash = 2166136261;
  for (const row of rows) {
    for (const value of row.values) {
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  return `${rows.length}x${fieldVector?.nComp ?? 0}:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function buildDataPreviewStepSignature(
  status: DataPreviewStepSignatureInput | null | undefined,
): string {
  if (!status) return "no solver sample";
  const step = status.step_index ?? "n/a";
  const simTime =
    status.sim_time_seconds == null
      ? "n/a"
      : `${formatPreviewNumber(status.sim_time_seconds)} s`;
  const updated =
    status.last_step_updated_at_unix_ms == null
      ? "no wall timestamp"
      : formatPreviewTimestamp(status.last_step_updated_at_unix_ms);
  const revision = status.revision == null ? "none" : String(status.revision);
  return `step ${step} | t=${simTime} | updated ${updated} | rev ${revision}`;
}

function centerBiasedSourceIndices(pointCount: number, count: number): number[] {
  const start = Math.floor((pointCount - count) / 2);
  const indices: number[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    indices.push(start + offset);
  }
  for (
    let left = start - 1, right = start + count;
    indices.length < pointCount && (left >= 0 || right < pointCount);
    left -= 1, right += 1
  ) {
    if (left >= 0) indices.push(left);
    if (right < pointCount) indices.push(right);
  }
  return indices;
}

function isZeroPoint(fieldVector: DecodedFieldVector, offset: number): boolean {
  for (let component = 0; component < fieldVector.nComp; component += 1) {
    if ((fieldVector.values[offset + component] ?? 0) !== 0) return false;
  }
  return true;
}

function formatPreviewTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return "invalid";
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return "invalid";
  return date.toISOString();
}

function formatPreviewNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0)) return "0";
  if (value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1e6 || absolute < 1e-4) {
    return value.toExponential(4);
  }
  return Number(value.toPrecision(6)).toString();
}
