import type {
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  descriptorForFrequencyTable,
  type AxisDescriptor,
} from "@/shared/domain/analysis/analysisSurfaceDescriptor";

export type FmrResponseState =
  | "cancel_requested"
  | "error"
  | "initial-loading"
  | "ready"
  | "refreshing"
  | "running"
  | "stale"
  | "unsupported";

export interface FmrResponseProgressView {
  complete: boolean;
  completedFrequencyPoints: number;
  currentFrequencyHz: number | null;
  partialArtifactsAvailable: boolean;
  state: string;
  status: string;
  totalFrequencyPoints: number;
}

export interface FmrResponsePeakRow {
  fieldAvailable: boolean;
  key: string;
  peak: FmrPeakPoint;
}

export interface FmrResponseSweepViewModel {
  canPlotSelectedFrequency: boolean;
  frequencyAxis: AxisDescriptor;
  peaks: readonly FmrResponsePeakRow[];
  progress: FmrResponseProgressView | null;
  responseAxes: readonly AxisDescriptor[];
  responseState: FmrResponseState;
  selectedFrequencyHz: number | null;
}

export function buildFmrResponseSweepViewModel({
  peaks,
  points,
  progress,
  resourceStatus,
  selectedFrequencyHz = null,
}: {
  peaks: readonly FmrPeakPoint[];
  points: readonly FrequencyResponsePoint[];
  progress: FmrResponseProgressView | null;
  resourceStatus: string;
  selectedFrequencyHz?: number | null;
}): FmrResponseSweepViewModel {
  const descriptor = descriptorForFrequencyTable(
    "frequency-domain:response-sweep",
  );
  const selectedPoint = points.find(
    (point) => point.frequencyHz === selectedFrequencyHz,
  );

  return {
    canPlotSelectedFrequency: Boolean(selectedPoint?.fieldId),
    frequencyAxis: descriptor.xAxis,
    peaks: peaks.map((peak, index) => ({
      fieldAvailable: Boolean(peak.fieldId),
      key: `${peak.source}:${peak.frequencyHz}:${peak.frequencyPointIndex ?? index}`,
      peak,
    })),
    progress,
    responseAxes: descriptor.yAxes,
    responseState: resolveFmrResponseState({
      pointCount: points.length,
      progress,
      resourceStatus,
    }),
    selectedFrequencyHz,
  };
}

function resolveFmrResponseState({
  pointCount,
  progress,
  resourceStatus,
}: {
  pointCount: number;
  progress: FmrResponseProgressView | null;
  resourceStatus: string;
}): FmrResponseState {
  if (resourceStatus === "error") return "error";
  if (resourceStatus === "unsupported") return "unsupported";
  if (progress?.state === "cancel_requested" || progress?.status === "cancel_requested") {
    return "cancel_requested";
  }
  if (progress?.state === "running" || progress?.status === "running") {
    return "running";
  }
  if (resourceStatus === "refreshing") return "refreshing";
  if (resourceStatus === "stale") return "stale";
  if ((resourceStatus === "idle" || resourceStatus === "loading") && pointCount === 0) {
    return "initial-loading";
  }
  return "ready";
}
