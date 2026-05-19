export interface MeshQualityHistogramBin {
  count: number;
  fraction: number;
  label: string;
  lo: number | null;
  hi: number | null;
}

export interface MeshQualityMetric {
  belowThresholdCount: number | null;
  belowThresholdFraction: number | null;
  histogram: MeshQualityHistogramBin[];
  id: "gamma" | "sicn";
  label: string;
  max: number | null;
  mean: number | null;
  min: number | null;
  p05: number | null;
  threshold: number | null;
}

export interface MeshWorstElement {
  centroid: [number, number, number] | null;
  elementIndex: number;
  gamma: number | null;
  scopeLabel: string;
  sicn: number | null;
  volume: number | null;
}

export interface MeshSizeDistribution {
  histogram: MeshQualityHistogramBin[];
  id: "edge_length" | "volume";
  label: string;
  max: number | null;
  mean: number | null;
  min: number | null;
  ratio: number | null;
  std: number | null;
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
  sizeDistributions: MeshSizeDistribution[];
  volumeRatio: number | null;
  warnings: string[];
  worstElements: MeshWorstElement[];
  worstElementsByMetric: {
    gamma: MeshWorstElement[];
    sicn: MeshWorstElement[];
  };
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

function asVector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = asNumber(value[0]);
  const y = asNumber(value[1]);
  const z = asNumber(value[2]);
  return x === null || y === null || z === null ? null : [x, y, z];
}

function metricLabel(id: "gamma" | "sicn"): string {
  return id === "sicn" ? "SICN" : "Gamma";
}

function formatBinNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs > 0 && (abs < 1e-3 || abs >= 1e4)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}

function formatBinLabel(lo: number | null, hi: number | null): string {
  if (lo === null || hi === null) return "unbounded";
  return `${formatBinNumber(lo)} to ${formatBinNumber(hi)}`;
}

function normalizeHistogram(
  value: unknown,
  fallbackLo: number,
  fallbackHi: number,
): MeshQualityHistogramBin[] {
  if (!Array.isArray(value)) return [];

  const rawBins: Omit<MeshQualityHistogramBin, "fraction">[] = [];
  value.forEach((entry, index) => {
    const record = asRecord(entry);
    if (record) {
      const lo = asNumber(record.lo);
      const hi = asNumber(record.hi);
      rawBins.push({
        count: asNumber(record.count) ?? 0,
        hi,
        label: formatBinLabel(lo, hi),
        lo,
      });
      return;
    }

    const count = asNumber(entry);
    if (count !== null) {
      const width = (fallbackHi - fallbackLo) / value.length;
      const lo = fallbackLo + width * index;
      const hi = fallbackLo + width * (index + 1);
      rawBins.push({
        count,
        hi,
        label: formatBinLabel(lo, hi),
        lo,
      });
    }
  });

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
    belowThresholdCount: asNumber(record.below_threshold_count),
    belowThresholdFraction: asNumber(record.below_threshold_fraction),
    histogram,
    id,
    label: metricLabel(id),
    max: asNumber(record.max),
    mean: asNumber(record.mean),
    min: asNumber(record.min),
    p05: asNumber(record.p05),
    threshold: asNumber(record.threshold),
  };
}

function normalizeSizeDistribution(
  id: MeshSizeDistribution["id"],
  label: string,
  value: unknown,
): MeshSizeDistribution | null {
  const record = asRecord(value);
  if (!record) return null;
  const min = asNumber(record.min);
  const max = asNumber(record.max);
  const histogram = normalizeHistogram(record.histogram, min ?? 0, max ?? 1);
  const mean = asNumber(record.mean);
  const std = asNumber(record.std);
  const ratio = asNumber(record.ratio);
  const hasDistribution =
    histogram.length > 0 ||
    min !== null ||
    mean !== null ||
    max !== null ||
    std !== null ||
    ratio !== null;
  if (!hasDistribution) return null;
  return {
    histogram,
    id,
    label,
    max,
    mean,
    min,
    ratio,
    std,
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
        centroid: asVector3(record.centroid),
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
  const edgeLengthDistribution = normalizeSizeDistribution(
    "edge_length",
    "Edge length",
    global.edge_length,
  );
  const volumeDistribution = normalizeSizeDistribution(
    "volume",
    "Element volume",
    global.volume,
  );
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
    sizeDistributions: [
      edgeLengthDistribution,
      volumeDistribution,
    ].filter(
      (distribution): distribution is MeshSizeDistribution =>
        distribution !== null,
    ),
    volumeRatio: asNumber(asRecord(global.volume)?.ratio),
    warnings,
    worstElements: normalizeWorstElements(record.worst_elements),
    worstElementsByMetric: {
      gamma: normalizeWorstElements(
        asRecord(record.worst_elements_by_metric)?.gamma,
      ),
      sicn: normalizeWorstElements(
        asRecord(record.worst_elements_by_metric)?.sicn,
      ),
    },
  };
}
