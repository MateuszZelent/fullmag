import {
  asRecord,
  formatLength,
  formatValue,
} from "../MeshResourceView";

export function meshDetailKey(
  prefix: string,
  fields: Array<unknown>,
): string {
  return fields.map((field) => formatValue(field)).join(":") || prefix;
}

function formatSizeFieldParam(key: string, value: unknown): string {
  const normalizedKey = key.toLowerCase();
  const likelyLength =
    normalizedKey.includes("size") ||
    normalizedKey.includes("target") ||
    normalizedKey.includes("hmin") ||
    normalizedKey.includes("hmax") ||
    normalizedKey === "lc" ||
    normalizedKey.endsWith("_lc") ||
    normalizedKey.includes("radius") ||
    normalizedKey.includes("distance") ||
    normalizedKey.includes("thickness");
  return `${key} ${likelyLength ? formatLength(value) : formatValue(value)}`;
}

export function sizeFieldParamSummary(params: unknown): string | null {
  const record = asRecord(params);
  if (!record) return null;
  const preferredKeys = [
    "hmin",
    "hmax",
    "target_size",
    "size",
    "lc",
    "min_size",
    "max_size",
    "thickness",
    "distance",
    "growth_rate",
  ];
  const entries: string[] = [];
  for (const key of preferredKeys) {
    if (record[key] !== undefined) {
      entries.push(formatSizeFieldParam(key, record[key]));
    }
  }
  if (entries.length > 0) return entries.slice(0, 4).join(" / ");
  return Object.entries(record)
    .slice(0, 4)
    .map(([key, value]) => formatSizeFieldParam(key, value))
    .join(" / ");
}
