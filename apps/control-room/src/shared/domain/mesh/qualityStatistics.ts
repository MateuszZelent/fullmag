export interface MeshQualityHistogramBin {
  count: number;
  fraction: number;
  label: string;
  lo: number | null;
  hi: number | null;
}

export interface MeshQualityMetric {
  histogram: MeshQualityHistogramBin[];
  id: "gamma" | "sicn";
  label: string;
  max: number | null;
  mean: number | null;
  min: number | null;
  p05: number | null;
}

export interface MeshWorstElement {
  elementIndex: number;
  gamma: number | null;
  scopeLabel: string;
  sicn: number | null;
  volume: number | null;
}

export interface MeshQualityStatistics {
  edgeLength: {
    max: number | null;
    mean: number | null;
    min: number | null;
    std: number | null;
  } | null;
  elementCount: number | null;
  meshName: string | null;
  metrics: MeshQualityMetric[];
  qualitySource: string | null;
  volumeRatio: number | null;
  warnings: string[];
  worstElements: MeshWorstElement[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function metricLabel(id: "gamma" | "sicn"): string {
  return id === "sicn" ? "SICN" : "Gamma";
}

function formatBinLabel(lo: number | null, hi: number | null): string {
  if (lo === null || hi === null) return "unbounded";
  return `${lo.toFixed(3)} to ${hi.toFixed(3)}`;
}

function normalizeHistogram(
  value: unknown,
  fallbackLo: number,
  fallbackHi: number,
): MeshQualityHistogramBin[] {
  if (!Array.isArray(value)) return [];

  const rawBins = value
    .map((entry, index) => {
      const record = asRecord(entry);
      if (record) {
        const lo = asNumber(record.lo);
        const hi = asNumber(record.hi);
        return {
          count: asNumber(record.count) ?? 0,
          hi,
          label: formatBinLabel(lo, hi),
          lo,
        };
      }
      const count = asNumber(entry);
      if (count === null) return null;
      const width = (fallbackHi - fallbackLo) / value.length;
      const lo = fallbackLo + width * index;
      const hi = fallbackLo + width * (index + 1);
      return {
        count,
        hi,
        label: formatBinLabel(lo, hi),
        lo,
      };
    })
    .filter((bin): bin is Omit<MeshQualityHistogramBin, "fraction"> => bin !== null);

  const maxCount = Math.max(...rawBins.map((bin) => bin.count), 0);
  return rawBins.map((bin) => ({
    ...bin,
    fraction: maxCount > 0 ? bin.count / maxCount : 0,
  }));
}

function normalizeMetric(
  id: "gamma" | "sicn",
  value: unknown,
): MeshQualityMetric | null {
  const record = asRecord(value);
  if (!record) return null;
  const histogram = normalizeHistogram(
    record.histogram,
    id === "sicn" ? -1 : 0,
    1,
  );
  const hasMetric =
    histogram.length > 0 ||
    asNumber(record.min) !== null ||
    asNumber(record.mean) !== null ||
    asNumber(record.max) !== null ||
    asNumber(record.p05) !== null;
  if (!hasMetric) return null;
  return {
    histogram,
    id,
    label: metricLabel(id),
    max: asNumber(record.max),
    mean: asNumber(record.mean),
    min: asNumber(record.min),
    p05: asNumber(record.p05),
  };
}

function normalizeWorstElements(value: unknown): MeshWorstElement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const elementIndex = asNumber(record?.element_index);
    if (record === null || elementIndex === null) return [];
    return [
      {
        elementIndex,
        gamma: asNumber(record.gamma),
        scopeLabel: asString(record.scope_label) ?? "unknown scope",
        sicn: asNumber(record.sicn),
        volume: asNumber(record.volume),
      },
    ];
  });
}

export function normalizeMeshQualityStatistics(
  value: unknown,
): MeshQualityStatistics | null {
  const record = asRecord(value);
  if (!record) return null;
  const global = asRecord(record.global) ?? asRecord(record.global_scope);
  if (!global) return null;

  const metrics = [
    normalizeMetric("sicn", global.sicn),
    normalizeMetric("gamma", global.gamma),
  ].filter((metric): metric is MeshQualityMetric => metric !== null);
  const warnings = Array.isArray(global.warnings)
    ? global.warnings.flatMap((warning) => {
        const text = asString(warning);
        return text ? [text] : [];
      })
    : [];

  return {
    edgeLength: asRecord(global.edge_length)
      ? {
          max: asNumber(asRecord(global.edge_length)?.max),
          mean: asNumber(asRecord(global.edge_length)?.mean),
          min: asNumber(asRecord(global.edge_length)?.min),
          std: asNumber(asRecord(global.edge_length)?.std),
        }
      : null,
    elementCount: asNumber(global.element_count),
    meshName: asString(record.mesh_name),
    metrics,
    qualitySource: asString(record.quality_source),
    volumeRatio: asNumber(asRecord(global.volume)?.ratio),
    warnings,
    worstElements: normalizeWorstElements(record.worst_elements),
  };
}
