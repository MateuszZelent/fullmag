import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";

export const SAVED_FIELD_PAGE_BYTES = 64 * 1024;
const MAX_U64 = BigInt("18446744073709551615");

function positiveCounter(value: string): bigint | null {
  if (typeof value !== "string" || value.length > 20 || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_U64 ? parsed : null;
}

/** Reject malformed coverage before it can throw during an Inspector render. */
export function savedFieldValuesWindow(coverage: MaterializedDatasetResource["field"]["coverage"]) {
  const components = positiveCounter(coverage.component_count);
  const total = positiveCounter(coverage.total_elements);
  if (components === null || total === null || !["f32", "f64"].includes(coverage.dtype)) return null;
  const width = BigInt(coverage.dtype === "f32" ? 4 : 8);
  const capacity = BigInt(SAVED_FIELD_PAGE_BYTES) / (components * width);
  if (capacity === BigInt(0)) return null;
  return { pageSize: capacity < BigInt(32) ? capacity : BigInt(32), total };
}
