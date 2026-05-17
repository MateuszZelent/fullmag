import type { MeshQualityStatistics } from "./qualityStatistics";

const GAMMA_MIN_THRESHOLD = 0.08;
const SICN_P05_THRESHOLD = 0.1;
const LOCAL_RADIUS_FACTOR = 2;
const LOCAL_HMAX_FACTOR = 0.5;
const NO_OP_SIZE = 1e22;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface MeshQualityRefinementPlan {
  elementIndex: number;
  fieldRadius: number;
  meshOptions: { [key: string]: JsonValue };
  metric: "gamma" | "sicn";
  targetHmax: number;
  threshold: number;
  value: number;
}

export interface MeshQualityRefinementState {
  plan: MeshQualityRefinementPlan | null;
  reason: string;
  status: "not_required" | "ready" | "unavailable";
}

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function thresholdBreach(
  statistics: MeshQualityStatistics,
): Pick<MeshQualityRefinementPlan, "metric" | "threshold" | "value"> | null {
  const gamma = statistics.metrics.find((metric) => metric.id === "gamma");
  if (typeof gamma?.min === "number" && gamma.min < GAMMA_MIN_THRESHOLD) {
    return {
      metric: "gamma",
      threshold: GAMMA_MIN_THRESHOLD,
      value: gamma.min,
    };
  }

  const sicn = statistics.metrics.find((metric) => metric.id === "sicn");
  if (typeof sicn?.p05 === "number" && sicn.p05 < SICN_P05_THRESHOLD) {
    return {
      metric: "sicn",
      threshold: SICN_P05_THRESHOLD,
      value: sicn.p05,
    };
  }

  return null;
}

function worstElementForMetric(
  statistics: MeshQualityStatistics,
  metric: "gamma" | "sicn",
) {
  return (
    statistics.worstElementsByMetric[metric][0] ??
    (metric === "gamma" ? statistics.worstElements[0] : undefined)
  );
}

export function resolveMeshQualityRefinementState(
  statistics: MeshQualityStatistics | null,
): MeshQualityRefinementState {
  if (!statistics) {
    return {
      plan: null,
      reason: "Mesh quality statistics are unavailable.",
      status: "unavailable",
    };
  }

  const breach = thresholdBreach(statistics);
  if (!breach) {
    return {
      plan: null,
      reason: "Quality thresholds are satisfied.",
      status: "not_required",
    };
  }

  const worst = worstElementForMetric(statistics, breach.metric);
  if (!worst?.centroid) {
    return {
      plan: null,
      reason: `${breach.metric.toUpperCase()}-ranked worst-element centroid is required for local refinement.`,
      status: "unavailable",
    };
  }

  const meanEdgeLength = positiveFinite(statistics.edgeLength?.mean);
  if (meanEdgeLength === null) {
    return {
      plan: null,
      reason: "Mean edge length is required for local refinement sizing.",
      status: "unavailable",
    };
  }

  const fieldRadius = meanEdgeLength * LOCAL_RADIUS_FACTOR;
  const targetHmax = meanEdgeLength * LOCAL_HMAX_FACTOR;
  const [x, y, z] = worst.centroid;
  const meshOptions = {
    compute_quality: true,
    per_element_quality: true,
    quality_refinement: {
      element_index: worst.elementIndex,
      kind: "worst_element_box",
      metric: breach.metric,
      radius: fieldRadius,
      target_hmax: targetHmax,
      threshold: breach.threshold,
      value: breach.value,
    },
    size_fields: [
      {
        kind: "Box",
        source: "quality_threshold_refinement",
        params: {
          VIn: targetHmax,
          VOut: NO_OP_SIZE,
          XMax: x + fieldRadius,
          XMin: x - fieldRadius,
          YMax: y + fieldRadius,
          YMin: y - fieldRadius,
          ZMax: z + fieldRadius,
          ZMin: z - fieldRadius,
        },
      },
    ],
  };

  return {
    plan: {
      elementIndex: worst.elementIndex,
      fieldRadius,
      meshOptions,
      metric: breach.metric,
      targetHmax,
      threshold: breach.threshold,
      value: breach.value,
    },
    reason: `${breach.metric} ${breach.value.toPrecision(3)} is below ${breach.threshold.toPrecision(3)}.`,
    status: "ready",
  };
}
