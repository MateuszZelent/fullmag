"use client";

/**
 * useAnalysisFrequencyData — resource hook for frequency-domain data.
 *
 * Owns:
 *   - /session/frequency-domain/manifest resource
 *   - /session/frequency-domain/spectrum resource (modal-spectrum route)
 *   - /session/frequency-domain/dispersion resource (dispersion route)
 *   - /session/frequency-domain/branches resource (dispersion route)
 *   - /session/frequency-domain/response-sweep resource (response-sweep route)
 *   - Route resolution (manifest → calculation mode → primaryChart)
 *   - ChartSeries derivation via frequencyDomainChartSeriesForAnalysisPlots
 *   - Selection-driven route override
 *
 * Enabled only when `activeSurface` is "frequency".
 *
 * Etap 10: controller split by resource family.
 * See: docs/analysis-tab-refactoring-plan.md §T10
 */

import { useMemo } from "react";

import type { ResourceRevision } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  buildFmrModalDrivenComparisonModel,
  type FrequencyDomainChartRoute,
  type FrequencyDomainResultContext,
  frequencyDomainChartRouteOverrideFromSelection,
  frequencyDomainChartRouteOverrideFromSubview,
  frequencyDomainManifestSupportsChartRoute,
  frequencyDomainResultTitle,
  frequencyDomainResultContextFromManifest,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import type { ChartSeries } from "../chartTableModel";
import { frequencyDomainChartSeriesForAnalysisPlots } from "../frequencyDomainSeriesAdapter";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { AnalysisSubview } from "@/kernel/workspace/analysisViewPreferences";

export interface FrequencyDomainPresentationResource {
  data: unknown | null;
  error: Error | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export interface AnalysisFrequencyDataResult {
  /** Derived series for EChartsSurface */
  frequencyDomainSeries: ChartSeries[];
  /** Computed status: "loading" | "ready" | "stale" | "error" */
  frequencyDomainStatus: string;
  /** Human-readable title for ChartSection heading */
  frequencyDomainTitle: string;
  /** Non-null when data can't be shown — displayed as empty-state message */
  frequencyDomainUnavailableReason: string | null;
  /** Resource presentation state, separate from scientific trust. */
  frequencyDomainPresentation: AnalysisFrequencyPresentationState;
  /** Resolved route (primaryChart, mode, status) */
  frequencyDomainRoute: Pick<FrequencyDomainChartRoute, "mode" | "primaryChart" | "status" | "unavailableReason">;
  /** Model detail for click-to-select in dispersion/spectrum/response charts */
  frequencyDomainDispersionModel: ReturnType<typeof buildEigenDispersionChartModel>;
  frequencyDomainResponseModel: ReturnType<typeof buildFrequencyResponseChartModel>;
  frequencyDomainSpectrumModel: ReturnType<typeof buildEigenSpectrumChartModel>;
  frequencyDomainComparisonModel: ReturnType<typeof buildFmrModalDrivenComparisonModel>;
}

export type AnalysisFrequencyPresentationState = ChartDataPresentationState & {
  physicalContext?: FrequencyDomainResultContext;
};

/**
 * Resource hook: frequency-domain data family.
 *
 * Enabled only when `activeSurface` is "frequency".
 * Only the resource for the active route loads — others remain disabled.
 */
export function useAnalysisFrequencyData(
  activeSurface: "dispersion" | "resonance-fmr" | "idle",
  activeSubview?: AnalysisSubview | null,
): AnalysisFrequencyDataResult {
  const loadFrequency = activeSurface !== "idle";

  const frequencyDomainManifest = useFrequencyDomainManifestResource({ enabled: loadFrequency });
  const frequencyDomainManifestRoute = routeFrequencyDomainCalculationMode(
    frequencyDomainManifest.data?.result_manifest?.payload,
  );
  const frequencyDomainContext = useMemo(
    () => frequencyDomainResultContextFromManifest(
      frequencyDomainManifest.data?.result_manifest?.payload,
    ),
    [frequencyDomainManifest.data?.result_manifest?.payload],
  );
  const frequencyDomainRouteOverride = useSelectionSelector(
    frequencyDomainChartRouteOverrideFromSelection,
  );
  const selectedResultRunId = useSelectionSelector((selection) =>
    selection.ref?.type === "frequency-domain"
      ? selection.ref.analysisRunId ?? null
      : null,
  );
  const frequencyDomainSubviewRouteOverride = frequencyDomainChartRouteOverrideFromSubview(activeSubview);
  const requestedRoutes = [
    frequencyDomainSubviewRouteOverride,
    frequencyDomainRouteOverride,
  ].filter((route): route is NonNullable<typeof route> => route !== null);
  const requestedRoute = requestedRoutes.at(-1) ?? null;
  const requestedRoutesConflict = requestedRoutes.some(
    (route) => route.primaryChart !== requestedRoute?.primaryChart,
  );
  const routePublishedByManifest = frequencyDomainManifest.status !== "ready" ||
    requestedRoutes.every((route) =>
      frequencyDomainManifestSupportsChartRoute(
        frequencyDomainManifest.data?.result_manifest?.payload,
        route,
      ),
    );
  const selectedRoute = requestedRoute
    ? { ...frequencyDomainManifestRoute, ...requestedRoute }
    : frequencyDomainManifestRoute;
  const frequencyDomainRoute: FrequencyDomainChartRoute =
    selectedRoute.primaryChart === "response-map"
      ? {
          ...selectedRoute,
          status: "unavailable",
          supportingCharts: [],
          unavailableReason: "Typed response-map resource is not available in the current Analysis contract.",
        }
      : requestedRoutesConflict || !routePublishedByManifest
        ? {
            ...selectedRoute,
            status: "unavailable",
            supportingCharts: [],
            unavailableReason: "The selected Analysis subview is not published by the selected frequency-domain manifest.",
          }
        : selectedRoute;
  const expectedChart = activeSurface === "dispersion" ? "dispersion" : null;
  const dispersionChart = frequencyDomainRoute.primaryChart === "dispersion" ||
    frequencyDomainRoute.primaryChart === "response-map";
  const resonanceChart =
    frequencyDomainRoute.primaryChart === "comparison" ||
    frequencyDomainRoute.primaryChart === "modal-spectrum" ||
    frequencyDomainRoute.primaryChart === "response-sweep";
  const manifestReady = frequencyDomainManifest.status === "ready" &&
    frequencyDomainRoute.status === "available";
  const surfaceMismatch = manifestReady && (
    expectedChart !== null
      ? !dispersionChart
      : activeSurface === "resonance-fmr" && !resonanceChart
  );
  const loadMatchingArtifact = loadFrequency && manifestReady && !surfaceMismatch;
  const resultContextMismatch = frequencyDomainManifest.status === "ready" &&
    selectedResultRunId !== null &&
    frequencyDomainContext.runId !== selectedResultRunId;

  // Load only the sub-resource required by the active route
  const frequencyDomainSpectrum = useFrequencyDomainEigenSpectrumResource({
    enabled: loadMatchingArtifact && !resultContextMismatch && (
      frequencyDomainRoute.primaryChart === "modal-spectrum" ||
      frequencyDomainRoute.primaryChart === "comparison"
    ),
  });
  const frequencyDomainDispersion = useFrequencyDomainEigenDispersionResource({
    enabled: loadMatchingArtifact && !resultContextMismatch && frequencyDomainRoute.primaryChart === "dispersion",
  });
  const frequencyDomainBranches = useFrequencyDomainEigenBranchesResource({
    enabled: loadMatchingArtifact && !resultContextMismatch && frequencyDomainRoute.primaryChart === "dispersion",
  });
  const frequencyDomainResponse = useFrequencyDomainResponseSweepResource({
    enabled: loadMatchingArtifact && !resultContextMismatch && (
      frequencyDomainRoute.primaryChart === "response-sweep" ||
      frequencyDomainRoute.primaryChart === "comparison"
    ),
  });

  const frequencyDomainSpectrumModel = useMemo(
    () => buildEigenSpectrumChartModel(frequencyDomainSpectrum.data),
    [frequencyDomainSpectrum.data],
  );
  const frequencyDomainDispersionModel = useMemo(
    () =>
      buildEigenDispersionChartModel(
        frequencyDomainDispersion.data,
        frequencyDomainBranches.data == null
          ? null
          : buildEigenBranchesModel(frequencyDomainBranches.data),
      ),
    [frequencyDomainBranches.data, frequencyDomainDispersion.data],
  );
  const frequencyDomainResponseModel = useMemo(
    () =>
      buildFrequencyResponseChartModel(
        frequencyDomainResponse.data,
        frequencyDomainManifest.data?.result_manifest?.payload,
      ),
    [
      frequencyDomainManifest.data?.result_manifest?.payload,
      frequencyDomainResponse.data,
    ],
  );
  const frequencyDomainComparisonModel = useMemo(
    () => buildFmrModalDrivenComparisonModel({
      manifestPayload: frequencyDomainManifest.data?.result_manifest?.payload,
      responseSweep: frequencyDomainResponse.data,
      spectrum: frequencyDomainSpectrum.data,
    }),
    [
      frequencyDomainManifest.data?.result_manifest?.payload,
      frequencyDomainResponse.data,
      frequencyDomainSpectrum.data,
    ],
  );

  const frequencyDomainSeries = useMemo<ChartSeries[]>(() => {
    if (surfaceMismatch || resultContextMismatch) return [];
    switch (frequencyDomainRoute.primaryChart) {
      case "dispersion":
        return frequencyDomainChartSeriesForAnalysisPlots(
          frequencyDomainDispersionModel,
        );
      case "modal-spectrum":
        return frequencyDomainChartSeriesForAnalysisPlots(
          frequencyDomainSpectrumModel,
        );
      case "response-sweep":
        return frequencyDomainChartSeriesForAnalysisPlots(
          frequencyDomainResponseModel,
        );
      case "comparison":
        return [];
      case "response-map":
        return [];
      default:
        return [];
    }
  }, [
    frequencyDomainDispersionModel,
    frequencyDomainRoute.primaryChart,
    frequencyDomainResponseModel,
    frequencyDomainSpectrumModel,
    resultContextMismatch,
    surfaceMismatch,
  ]);

  const frequencyDomainResourceStatus =
    frequencyDomainRoute.primaryChart === "dispersion"
      ? frequencyDomainDispersion.status
      : frequencyDomainRoute.primaryChart === "response-sweep"
        ? frequencyDomainResponse.status
        : frequencyDomainRoute.primaryChart === "comparison"
          ? combinedFrequencyDomainResourceStatus(
              frequencyDomainSpectrum.status,
              frequencyDomainResponse.status,
            )
        : frequencyDomainRoute.primaryChart === "modal-spectrum"
          ? frequencyDomainSpectrum.status
          : frequencyDomainManifest.status;

  const frequencyDomainStatus =
    resultContextMismatch ? "unsupported"
      : surfaceMismatch ? "unsupported"
      : frequencyDomainRoute.status === "available"
        ? frequencyDomainResourceStatus
        : frequencyDomainManifest.status === "ready"
          ? "unsupported"
          : frequencyDomainManifest.status;

  const frequencyDomainTitle = frequencyDomainChartTitle(
    frequencyDomainRoute.primaryChart,
    frequencyDomainContext.classification,
  );

  const frequencyDomainUnavailableReason =
    resultContextMismatch
      ? "The selected result run is not the run published by the current-session frequency-domain resources."
      : surfaceMismatch
      ? `This artifact does not publish a result compatible with the ${activeSurface} surface.`
      : frequencyDomainRoute.unavailableReason ??
        firstFrequencyDomainDiagnostic([
          frequencyDomainDispersionModel.diagnostics,
          frequencyDomainResponseModel.diagnostics,
          frequencyDomainSpectrumModel.diagnostics,
        ]);

  const frequencyDomainResource =
    frequencyDomainRoute.primaryChart === "dispersion"
      ? frequencyDomainDispersion
      : frequencyDomainRoute.primaryChart === "response-sweep"
        ? frequencyDomainResponse
        : frequencyDomainRoute.primaryChart === "comparison"
          ? frequencyDomainResponse
        : frequencyDomainRoute.primaryChart === "modal-spectrum"
          ? frequencyDomainSpectrum
          : frequencyDomainManifest;
  const frequencyDomainPresentation = useMemo<AnalysisFrequencyPresentationState>(
    () => ({
      ...deriveFrequencyDomainPresentationState(
        frequencyDomainResource,
        frequencyDomainStatus,
        frequencyDomainUnavailableReason,
      ),
      physicalContext: frequencyDomainContext,
    }),
    [
      frequencyDomainContext,
      frequencyDomainResource,
      frequencyDomainStatus,
      frequencyDomainUnavailableReason,
    ],
  );

  return {
    frequencyDomainSeries,
    frequencyDomainStatus,
    frequencyDomainTitle,
    frequencyDomainUnavailableReason,
    frequencyDomainRoute,
    frequencyDomainPresentation,
    frequencyDomainDispersionModel,
    frequencyDomainResponseModel,
    frequencyDomainSpectrumModel,
    frequencyDomainComparisonModel,
  };
}

function combinedFrequencyDomainResourceStatus(
  left: ResourceStatus,
  right: ResourceStatus,
): ResourceStatus {
  if (left === "error" || right === "error") return "error";
  if (left === "loading" || right === "loading") return "loading";
  if (left === "stale" || right === "stale") return "stale";
  if (left === "ready" && right === "ready") return "ready";
  return "idle";
}

export function deriveFrequencyDomainPresentationState(
  resource: FrequencyDomainPresentationResource,
  status: string,
  unsupportedReason: string | null,
): ChartDataPresentationState {
  if (status === "unsupported") {
    return {
      kind: "unsupported",
      reason: unsupportedReason ?? "The selected frequency-domain resource is unsupported.",
    };
  }

  const data = resource.data;
  const revision = resource.revision;
  const error = resource.error ?? new Error("Frequency-domain resource unavailable");

  if (data === null) {
    if (status === "error") return { kind: "error", error };
    if (status === "loading" || status === "stale") return { kind: "initial-loading" };
    return { kind: "empty", revision };
  }

  if (status === "error") {
    return revision == null
      ? { kind: "error", error }
      : { kind: "stale", error, visibleRevision: revision };
  }
  if (status === "loading" || status === "stale") {
    return revision == null
      ? { kind: "initial-loading" }
      : { kind: "refreshing", requestedRevision: revision, visibleRevision: revision };
  }
  if (status === "ready") {
    return revision == null ? { kind: "empty", revision: null } : { kind: "ready", revision };
  }
  return { kind: "empty", revision };
}

// ===== Utilities extracted from controller =====

export function frequencyDomainChartTitle(
  primaryChart: string,
  classification: FrequencyDomainResultContext["classification"],
): string {
  if (primaryChart !== "comparison" && primaryChart !== "dispersion" && primaryChart !== "modal-spectrum" &&
    primaryChart !== "response-map" && primaryChart !== "response-sweep") return "Frequency Domain";
  return frequencyDomainResultTitle(primaryChart, classification);
}

function firstFrequencyDomainDiagnostic(
  diagnosticLists: readonly (readonly string[])[],
): string | null {
  for (const list of diagnosticLists) {
    for (const msg of list) {
      if (msg) return msg;
    }
  }
  return null;
}
