export interface CrossSectionQualitySample {
  qualityValue: number | null;
  visible: boolean;
}

export interface CrossSectionQualityHistogramBin {
  count: number;
  hi: number;
  label: string;
  lo: number;
}

export interface CrossSectionQualityStatistics {
  belowThresholdCount: number | null;
  histogram: CrossSectionQualityHistogramBin[];
  max: number | null;
  mean: number | null;
  min: number | null;
  p05: number | null;
  polygonCount: number;
  threshold: number | null;
  visiblePolygonCount: number;
}

export interface CrossSectionQualityStatisticsOptions {
  histogramBinCount?: number;
  threshold?: number | null;
}

export interface CrossSectionIntersectionStatistics {
  edgeIntersectionCount: number;
  meshNodeCount: number;
  totalPointCount: number;
}

const FMCS_POINT_KIND_EDGE_INTERSECTION = 0;
const FMCS_POINT_KIND_MESH_NODE = 1;

export function buildCrossSectionQualityStatistics(
  samples: readonly CrossSectionQualitySample[],
  options: CrossSectionQualityStatisticsOptions = {},
): CrossSectionQualityStatistics {
  const threshold = normalizedOptionalNumber(options.threshold);
  const histogramBinCount = Math.max(1, Math.floor(options.histogramBinCount ?? 10));
  const allValues = samples
    .map((sample) => sample.qualityValue)
    .filter(isFiniteNumber);
  const visibleValues = samples
    .filter((sample) => sample.visible)
    .map((sample) => sample.qualityValue)
    .filter(isFiniteNumber);

  if (visibleValues.length === 0) {
    return {
      belowThresholdCount: threshold === null ? null : 0,
      histogram: buildQualityHistogram([], allValues, histogramBinCount),
      max: null,
      mean: null,
      min: null,
      p05: null,
      polygonCount: samples.length,
      threshold,
      visiblePolygonCount: 0,
    };
  }

  const sorted = [...visibleValues].sort((left, right) => left - right);
  const sum = visibleValues.reduce((total, value) => total + value, 0);
  return {
    belowThresholdCount:
      threshold === null
        ? null
        : visibleValues.filter((value) => value < threshold).length,
    histogram: buildQualityHistogram(visibleValues, allValues, histogramBinCount),
    max: sorted[sorted.length - 1],
    mean: sum / visibleValues.length,
    min: sorted[0],
    p05: quantileNearest(sorted, 0.05),
    polygonCount: samples.length,
    threshold,
    visiblePolygonCount: visibleValues.length,
  };
}

export function buildCrossSectionIntersectionStatistics(
  intersectionKinds: Uint32Array | null | undefined,
): CrossSectionIntersectionStatistics {
  if (!intersectionKinds) {
    return {
      edgeIntersectionCount: 0,
      meshNodeCount: 0,
      totalPointCount: 0,
    };
  }

  let edgeIntersectionCount = 0;
  let meshNodeCount = 0;
  for (const kind of intersectionKinds) {
    if (kind === FMCS_POINT_KIND_EDGE_INTERSECTION) {
      edgeIntersectionCount += 1;
    } else if (kind === FMCS_POINT_KIND_MESH_NODE) {
      meshNodeCount += 1;
    }
  }

  return {
    edgeIntersectionCount,
    meshNodeCount,
    totalPointCount: intersectionKinds.length,
  };
}

function buildQualityHistogram(
  values: number[],
  rangeValues: number[],
  binCount: number,
): CrossSectionQualityHistogramBin[] {
  const rangeSource = rangeValues.length > 0 ? rangeValues : values;
  if (rangeSource.length === 0) return [];

  const min = Math.min(...rangeSource);
  const max = Math.max(...rangeSource);
  if (min === max) {
    return [
      {
        count: values.length,
        hi: max,
        label: `${formatStatisticValue(min)} to ${formatStatisticValue(max)}`,
        lo: min,
      },
    ];
  }

  const width = (max - min) / binCount;
  const bins: CrossSectionQualityHistogramBin[] = Array.from(
    { length: binCount },
    (_, index) => {
      const lo = min + width * index;
      const hi = index === binCount - 1 ? max : min + width * (index + 1);
      return {
        count: 0,
        hi,
        label: `${formatStatisticValue(lo)} to ${formatStatisticValue(hi)}`,
        lo,
      };
    },
  );

  for (const value of values) {
    const index = Math.min(
      binCount - 1,
      Math.max(0, Math.floor((value - min) / width)),
    );
    bins[index].count += 1;
  }
  return bins;
}

function quantileNearest(sortedValues: number[], quantile: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(
      sortedValues.length - 1,
      Math.floor((sortedValues.length - 1) * quantile),
    ),
  );
  return sortedValues[index];
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedOptionalNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatStatisticValue(value: number): string {
  return Number(value.toPrecision(6)).toString();
}
