import type { DecodedFieldVector } from "@/kernel/api/codecs";

export interface DataPreviewRow {
  index: number;
  sourceIndex: number;
  values: string[];
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
  const start = Math.floor((fieldVector.pointCount - count) / 2);
  const rows: DataPreviewRow[] = [];
  for (let row = 0; row < count; row += 1) {
    const sourceIndex = start + row;
    const offset = sourceIndex * fieldVector.nComp;
    const values: string[] = [];
    for (let component = 0; component < fieldVector.nComp; component += 1) {
      values.push(
        formatPreviewNumber(fieldVector.values[offset + component] ?? 0),
      );
    }
    rows.push({ index: row, sourceIndex, values });
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
