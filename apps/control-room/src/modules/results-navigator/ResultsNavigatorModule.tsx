"use client";

import { useCallback, useMemo, useState } from "react";

import {
  useAnalysisResultBranchesResource,
  useAnalysisResultDatasetCatalogResource,
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultItemsResource,
  useAnalysisResultSamplesResource,
} from "@/kernel/resources/analysisResultResources";
import type {
  AnalysisResultDatasetManifestResource,
  AnalysisResultPageQuery,
} from "@/kernel/api/apiTypes";
import {
  useCurrentRunResource,
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenFieldSweepResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainFmrKittelFitResource,
  useFrequencyDomainFmrPeaksResource,
  useFrequencyDomainFmrResonanceFitsResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseDiagnosticsResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  analysisResultFieldOverlayAdapter,
  createAnalysisResultFieldOverlayIntent,
} from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";

import { ResultsNavigatorTree } from "./ResultsNavigatorTree";
import { ResultDatasetBrowser } from "./ResultDatasetBrowser";
import {
  buildResultDatasetBrowserModel,
  buildResultDatasetItemPageQuery,
  resultDatasetFilterErrorMessage,
  resultPageForDataset,
  type ResultDatasetItemStatusFilter,
} from "./resultDatasetBrowserModel";
import {
  analysisResultAxisPresentation,
  analysisResultSelectionRef,
  type AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";
import {
  buildFrequencyDomainResultsTree,
  mapNavigatorArtifactState,
  mapResourceResultState,
} from "./resultsNavigatorModel";
import {
  navigatorArtifactFromResource,
  navigatorBranchesFromResource,
  navigatorFieldSweepFromResource,
  navigatorFmrFromResource,
  navigatorKittelFitArtifactFromResource,
  navigatorManifestFromResource,
  navigatorProgressFromResource,
  navigatorResonanceFitsFromResource,
  navigatorResonanceFitsArtifactFromResource,
  navigatorResponseFromResource,
  navigatorSpectrumFromResource,
  type FrequencyDomainNavigatorInput,
  type NavigatorIdentity,
  type ResultsNavigatorNode,
} from "./resultsNavigatorTypes";
import {
  kernelSelectionForResultsNavigatorNode,
} from "./resultsNavigatorSelection";

function activeStageId(
  activeStageIndex: number | null | undefined,
  stages: readonly { index: number; stage_id: string }[] | undefined,
): string | null {
  if (activeStageIndex == null || !stages) return null;
  return stages.find((stage) => stage.index === activeStageIndex)?.stage_id ?? null;
}

function resolveIdentity({
  currentRun,
  stageExecution,
}: {
  currentRun: ReturnType<typeof useCurrentRunResource>["data"];
  stageExecution: ReturnType<typeof useStageExecutionResource>["data"];
}): NavigatorIdentity | null {
  if (!currentRun || !stageExecution) return null;
  const stageId = activeStageId(
    currentRun.active_stage_index ?? stageExecution.active_stage_index,
    stageExecution.stages,
  );
  if (!stageId) return null;
  return {
    runId: currentRun.run_id,
    stageId,
  };
}

function selectionWithAxisFilters(
  selection: AnalysisResultSelectionRef,
  axisFilters: Readonly<Record<string, string>>,
): AnalysisResultSelectionRef {
  const {
    kind: _kind,
    nodeId: _nodeId,
    type: _type,
    ...identity
  } = selection;
  return analysisResultSelectionRef({
    ...identity,
    axisFilters,
  });
}

function axisFiltersKey(filters: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filters).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function resultSelectionForAnalysis(
  manifest: AnalysisResultDatasetManifestResource | null,
  selection: AnalysisResultSelectionRef | null,
): AnalysisResultSelectionRef | null {
  if (!manifest) return null;
  if (
    selection &&
    selection.runId === manifest.run_id &&
    selection.stageId === manifest.stage_id &&
    selection.datasetId === manifest.dataset_id &&
    selection.datasetRevision === manifest.dataset_revision
  ) {
    return selection;
  }
  return analysisResultSelectionRef({
    datasetId: manifest.dataset_id,
    datasetRevision: manifest.dataset_revision,
    focus: "dataset",
    runId: manifest.run_id,
    stageId: manifest.stage_id,
  });
}

export default function ResultsNavigatorModule({
  kernel,
  moduleId,
}: ModuleProps) {
  const currentRun = useCurrentRunResource();
  const stageExecution = useStageExecutionResource();
  const resultRunId = currentRun.data?.run_id ?? null;
  const [resultDatasetSearch, setResultDatasetSearch] = useState("");
  const [resultCatalogPageState, setResultCatalogPageState] = useState<{
    cursor: string | null;
    key: string;
  }>({ cursor: null, key: "" });
  const [resultItemFieldFilter, setResultItemFieldFilter] = useState<
    "all" | "true" | "false"
  >("all");
  const [resultItemSort, setResultItemSort] = useState("display_index_asc");
  const [resultItemStatusFilter, setResultItemStatusFilter] =
    useState<ResultDatasetItemStatusFilter>("all");
  const [resultItemFrequencyMin, setResultItemFrequencyMin] = useState("");
  const [resultItemFrequencyMax, setResultItemFrequencyMax] = useState("");
  const [resultItemResidualMax, setResultItemResidualMax] = useState("");
  const resultCatalogPageKey = resultDatasetSearch.trim();
  const resultCatalogCursor =
    resultCatalogPageState.key === resultCatalogPageKey
      ? resultCatalogPageState.cursor
      : null;
  const resultCatalogQuery = useMemo(
    () => ({
      ...(resultCatalogCursor ? { cursor: resultCatalogCursor } : {}),
      limit: 50,
      sort: "dataset_id_asc",
      ...(resultDatasetSearch.trim()
        ? { search: resultDatasetSearch.trim() }
        : {}),
    }),
    [resultCatalogCursor, resultDatasetSearch],
  );
  const resultCatalog = useAnalysisResultDatasetCatalogResource(resultRunId, {
    query: resultCatalogQuery,
  });
  const resultCatalogHasItems = (resultCatalog.data?.items.length ?? 0) > 0;
  const resultCatalogSearchActive = resultDatasetSearch.trim().length > 0;
  const resultDatasetBrowserVisible =
    resultCatalogHasItems ||
    resultCatalogSearchActive ||
    resultCatalog.status === "loading" ||
    resultCatalog.status === "stale" ||
    resultCatalog.status === "error";
  const legacyResultsFallbackEnabled =
    Boolean(resultRunId) &&
    !resultDatasetBrowserVisible &&
    resultCatalog.status === "ready";
  const selectedResultDatasetId = useSelectionSelector((selection) => {
    const ref = selection.ref;
    return ref?.type === "analysis-result" && ref.runId === resultRunId
      ? ref.datasetId
      : null;
  });
  const selectedResultSampleId = useSelectionSelector((selection) => {
    const ref = selection.ref;
    return ref?.type === "analysis-result" && ref.datasetId === selectedResultDatasetId
      ? ref.sampleId ?? null
      : null;
  });
  const selectedResultSelection = useSelectionSelector(
    (selection): AnalysisResultSelectionRef | null => {
      const ref = selection.ref;
      return ref?.type === "analysis-result" ? ref : null;
    },
  );
  const resultDatasetId =
    selectedResultDatasetId ?? resultCatalog.data?.items[0]?.dataset_id ?? null;
  const selectedResultAxisFilterKey = useSelectionSelector((selection) => {
    const ref = selection.ref;
    if (ref?.type !== "analysis-result" || ref.datasetId !== selectedResultDatasetId) {
      return "{}";
    }
    if (ref.axisFilters) return axisFiltersKey(ref.axisFilters);
    return ref.axisId && ref.axisValueToken
      ? axisFiltersKey({ [ref.axisId]: ref.axisValueToken })
      : "{}";
  });
  const selectedResultAxisFilters = useMemo(
    () => JSON.parse(selectedResultAxisFilterKey) as Record<string, string>,
    [selectedResultAxisFilterKey],
  );
  const [resultAxisFilters, setResultAxisFilters] = useState<Record<string, string>>({});
  const [resultAxisDisplayUnits, setResultAxisDisplayUnits] = useState<Record<string, string>>({});
  const [resultAxisFilterDatasetId, setResultAxisFilterDatasetId] =
    useState<string | null>(null);
  const [resultBranchFilter, setResultBranchFilter] = useState<string | null>(null);
  const [resultBranchFilterDatasetId, setResultBranchFilterDatasetId] =
    useState<string | null>(null);
  const [resultFollowedBranchId, setResultFollowedBranchId] = useState<string | null>(null);
  const effectiveResultAxisFilters = useMemo(
    () =>
      resultAxisFilterDatasetId === resultDatasetId
        ? resultAxisFilters
        : selectedResultAxisFilters,
    [
      resultAxisFilterDatasetId,
      resultAxisFilters,
      resultDatasetId,
      selectedResultAxisFilters,
    ],
  );
  const resultManifest = useAnalysisResultDatasetManifestResource(
    resultRunId,
    resultDatasetId,
  );
  const resultServerFiltering =
    resultManifest.data?.capabilities.server_filtering === true;
  const resultServerSorting =
    resultManifest.data?.capabilities.server_sorting === true;
  const resultAxisQuery = useMemo<AnalysisResultPageQuery>(
    () =>
      resultServerFiltering
        ? (Object.fromEntries(
            Object.entries(effectiveResultAxisFilters).map(([axisId, token]) => [
              `coordinate.${axisId}`,
              token,
            ]),
          ) as AnalysisResultPageQuery)
        : {},
    [effectiveResultAxisFilters, resultServerFiltering],
  );
  const resultAxisFiltersKey = axisFiltersKey(effectiveResultAxisFilters);
  const effectiveResultBranchId =
    resultManifest.data?.capabilities.branch_tracking &&
    resultBranchFilterDatasetId === resultDatasetId
      ? resultBranchFilter
      : null;
  const effectiveFollowedBranchId =
    resultManifest.data?.capabilities.branch_tracking &&
    resultBranchFilterDatasetId === resultDatasetId
      ? resultFollowedBranchId
      : null;
  const resultSamplePageKey = `${resultDatasetId ?? "none"}:${selectedResultSampleId ?? "all"}:${resultAxisFiltersKey}`;
  const resultItemPageKey = `${resultSamplePageKey}:${resultServerFiltering ? resultItemFieldFilter : "all"}:${resultServerSorting ? resultItemSort : "display_index_asc"}:${resultServerFiltering ? resultItemStatusFilter : "all"}:${resultServerFiltering ? resultItemFrequencyMin : ""}:${resultServerFiltering ? resultItemFrequencyMax : ""}:${resultServerFiltering ? resultItemResidualMax : ""}:${resultServerFiltering ? effectiveResultBranchId ?? "all-branches" : "all-branches"}`;
  const resultItemFilterError = resultDatasetFilterErrorMessage(
    resultItemFrequencyMin,
    resultItemFrequencyMax,
    resultItemResidualMax,
  );
  const resultBranchPageKey = resultDatasetId ?? "none";
  const [samplePageState, setSamplePageState] = useState<{
    cursor: string | null;
    key: string;
  }>({ cursor: null, key: "" });
  const [itemPageState, setItemPageState] = useState<{
    cursor: string | null;
    key: string;
  }>({ cursor: null, key: "" });
  const [branchPageState, setBranchPageState] = useState<{
    cursor: string | null;
    key: string;
  }>({ cursor: null, key: "" });
  const sampleCursor =
    samplePageState.key === resultSamplePageKey ? samplePageState.cursor : null;
  const itemCursor =
    itemPageState.key === resultItemPageKey ? itemPageState.cursor : null;
  const branchCursor =
    branchPageState.key === resultBranchPageKey ? branchPageState.cursor : null;
  const resultSamples = useAnalysisResultSamplesResource(
    resultRunId,
    resultDatasetId,
    {
      query: {
        limit: 50,
        ...resultAxisQuery,
        ...(sampleCursor ? { cursor: sampleCursor } : {}),
      },
    },
  );
  const resultItems = useAnalysisResultItemsResource(
    resultRunId,
    resultDatasetId,
    {
      query: buildResultDatasetItemPageQuery({
        axisFilters: effectiveResultAxisFilters,
        branchId: effectiveResultBranchId,
        cursor: itemCursor,
        frequencyMax: resultItemFrequencyMax,
        frequencyMin: resultItemFrequencyMin,
        itemFieldFilter: resultItemFieldFilter,
        itemStatusFilter: resultItemStatusFilter,
        itemSort: resultItemSort,
        residualMax: resultItemResidualMax,
        sampleId: selectedResultSampleId,
        serverFiltering: resultServerFiltering,
        serverSorting: resultServerSorting,
      }),
    },
  );
  const resultBranches = useAnalysisResultBranchesResource(
    resultRunId,
    resultDatasetId,
    {
      enabled: Boolean(resultManifest.data?.capabilities.branch_tracking),
      query: {
        limit: 50,
        ...(branchCursor ? { cursor: branchCursor } : {}),
        ...(resultServerSorting ? { sort: "branch_id_asc" } : {}),
      },
    },
  );
  const verifiedResultSamples = resultPageForDataset(
    resultSamples.data,
    resultManifest.data,
  );
  const verifiedResultItems = resultPageForDataset(
    resultItems.data,
    resultManifest.data,
  );
  const verifiedResultBranches = resultPageForDataset(
    resultBranches.data,
    resultManifest.data,
  );
  const manifest = useFrequencyDomainManifestResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const spectrum = useFrequencyDomainEigenSpectrumResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const branches = useFrequencyDomainEigenBranchesResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const dispersion = useFrequencyDomainEigenDispersionResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const fieldSweep = useFrequencyDomainEigenFieldSweepResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const fmrPeaks = useFrequencyDomainFmrPeaksResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const fmrResonanceFits = useFrequencyDomainFmrResonanceFitsResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const fmrKittelFit = useFrequencyDomainFmrKittelFitResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const response = useFrequencyDomainResponseSweepResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const responseProgress = useFrequencyDomainResponseProgressResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const responseDiagnostics = useFrequencyDomainResponseDiagnosticsResource({
    enabled: legacyResultsFallbackEnabled,
  });
  const selectedNodeId = useSelectionSelector((selection) => selection.nodeId);

  const resultBrowserModel = useMemo(
    () =>
      buildResultDatasetBrowserModel({
        catalog: resultCatalog.data,
        branches: verifiedResultBranches,
        items: verifiedResultItems,
        manifest: resultManifest.data,
        samples: verifiedResultSamples,
        selectedDatasetId: selectedResultDatasetId,
      }),
    [
      resultCatalog.data,
      verifiedResultBranches,
      verifiedResultItems,
      resultManifest.data,
      verifiedResultSamples,
      selectedResultDatasetId,
    ],
  );

  const identity = useMemo(
    () =>
      resolveIdentity({
        currentRun: currentRun.data,
        stageExecution: stageExecution.data,
      }),
    [currentRun.data, stageExecution.data],
  );
  const input = useMemo<FrequencyDomainNavigatorInput>(
    () => {
      const typedSpectrum = navigatorSpectrumFromResource(spectrum.data);
      const typedBranches = navigatorBranchesFromResource(branches.data);
      const typedResponse = navigatorResponseFromResource(response.data);
      const typedFmr = navigatorFmrFromResource(fmrPeaks.data);
      const typedResonanceFits = navigatorResonanceFitsFromResource(fmrResonanceFits.data);
      const typedFieldSweep = navigatorFieldSweepFromResource(fieldSweep.data, {
        branches: typedBranches,
        branchesRevision: navigatorArtifactFromResource(branches.data)?.resourceRevision,
        spectrum: typedSpectrum,
        spectrumRevision: navigatorArtifactFromResource(spectrum.data)?.resourceRevision,
      });
      const resonanceFitsArtifact =
        navigatorResonanceFitsArtifactFromResource(fmrResonanceFits.data);
      const kittelFitArtifact =
        navigatorKittelFitArtifactFromResource(fmrKittelFit.data);
      const resonanceFitsTransportState =
        mapResourceResultState(fmrResonanceFits);
      const kittelFitTransportState = mapResourceResultState(fmrKittelFit);
      return {
        branches: typedBranches,
        identity,
        manifest: navigatorManifestFromResource(manifest.data),
        manifestState: manifest.data
          ? undefined
          : manifest.status === "loading"
            ? "loading"
            : manifest.status === "error"
              ? "error"
              : "missing",
        progress: navigatorProgressFromResource(responseProgress.data),
        progressState: responseProgress.data
          ? undefined
          : responseProgress.status === "loading"
            ? "loading"
            : responseProgress.status === "error"
              ? "error"
              : "missing",
        resources: {
          branches: navigatorArtifactFromResource(branches.data),
          dispersion: navigatorArtifactFromResource(dispersion.data),
          fieldSweep: navigatorArtifactFromResource(fieldSweep.data),
          response: navigatorArtifactFromResource(response.data),
          responseDiagnostics: navigatorArtifactFromResource(responseDiagnostics.data),
          resultManifest: navigatorArtifactFromResource(manifest.data?.result_manifest),
          spectrum: navigatorArtifactFromResource(spectrum.data),
          states: {
            branches: mapResourceResultState(branches),
            dispersion: mapResourceResultState(dispersion),
            fieldSweep: mapResourceResultState(fieldSweep),
            response: mapResourceResultState(response),
            responseDiagnostics: mapResourceResultState(responseDiagnostics),
            resultManifest: manifest.data?.result_manifest
              ? mapNavigatorArtifactState(
                  navigatorArtifactFromResource(manifest.data.result_manifest),
                )
              : "missing",
            spectrum: mapResourceResultState(spectrum),
          },
        },
        fmr: {
          kittelFit: kittelFitArtifact,
          peaks: navigatorArtifactFromResource(fmrPeaks.data),
          resonanceFits: resonanceFitsArtifact,
          ...(typedResonanceFits ? { resonanceFitsPayload: typedResonanceFits } : {}),
          states: {
            kittelFit:
              kittelFitTransportState === "ready"
                ? mapNavigatorArtifactState(kittelFitArtifact)
                : kittelFitTransportState,
            peaks: mapResourceResultState(fmrPeaks),
            resonanceFits:
              resonanceFitsTransportState === "ready"
                ? mapNavigatorArtifactState(resonanceFitsArtifact)
                : resonanceFitsTransportState,
          },
          ...(typedFmr ? { payload: typedFmr } : {}),
        },
        response: typedResponse,
        fieldSweep: typedFieldSweep,
        spectrum: typedSpectrum,
      } satisfies FrequencyDomainNavigatorInput;
    },
    [
      branches,
      dispersion,
      fieldSweep,
      fmrKittelFit,
      fmrPeaks,
      fmrResonanceFits,
      identity,
      manifest.data,
      manifest.status,
      response,
      responseDiagnostics,
      responseProgress.data,
      responseProgress.status,
      spectrum,
    ],
  );
  const nodes = useMemo(() => buildFrequencyDomainResultsTree(input), [input]);
  const onSelect = useCallback(
    (node: ResultsNavigatorNode) => {
      const { kind, ref } = kernelSelectionForResultsNavigatorNode(node);
      kernel.selection.set(
        {
          kind,
          label: node.label,
          nodeId: node.id,
          objectId: null,
          ref,
        },
        moduleId,
      );
    },
    [kernel.selection, moduleId],
  );
  const onSelectResult = useCallback(
    (selection: AnalysisResultSelectionRef) => {
      const nextAxisFilters =
        selection.datasetId === selectedResultDatasetId
          ? effectiveResultAxisFilters
          : {};
      setResultAxisFilters({ ...nextAxisFilters });
      setResultAxisFilterDatasetId(selection.datasetId);
      if (selection.datasetId !== selectedResultDatasetId) {
        setResultAxisDisplayUnits({});
        setResultBranchFilter(null);
        setResultBranchFilterDatasetId(selection.datasetId);
        setResultFollowedBranchId(null);
      }
      const nextSelection = selectionWithAxisFilters(
        selection,
        nextAxisFilters,
      );
      kernel.selection.set(
        {
          kind: nextSelection.kind,
          label:
            nextSelection.itemId ??
            nextSelection.sampleId ??
            nextSelection.datasetId,
          nodeId: nextSelection.nodeId,
          objectId: null,
          ref: nextSelection,
        },
        moduleId,
      );
    },
    [
      effectiveResultAxisFilters,
      kernel.selection,
      moduleId,
      selectedResultDatasetId,
    ],
  );
  const onResultDatasetSearchChange = useCallback((value: string) => {
    const key = value.trim();
    setResultDatasetSearch(value);
    setResultCatalogPageState({ cursor: null, key });
  }, []);
  const onResultBranchFilterChange = useCallback(
    (branchId: string | null) => {
      const manifestData = resultManifest.data;
      if (
        !manifestData?.capabilities.branch_tracking ||
        !manifestData.capabilities.server_filtering
      ) {
        return;
      }
      setResultBranchFilter(branchId);
      setResultBranchFilterDatasetId(manifestData.dataset_id);
      setResultFollowedBranchId(null);
    },
    [resultManifest.data],
  );
  const onFollowResultBranch = useCallback(
    (branchId: string | null) => {
      const manifestData = resultManifest.data;
      if (
        !manifestData?.capabilities.branch_tracking ||
        !manifestData.capabilities.server_filtering
      ) {
        return;
      }
      setResultBranchFilter(branchId);
      setResultBranchFilterDatasetId(manifestData.dataset_id);
      setResultFollowedBranchId(branchId);
      if (!branchId) return;
      const selection = analysisResultSelectionRef({
        axisFilters: effectiveResultAxisFilters,
        branchId,
        datasetId: manifestData.dataset_id,
        datasetRevision: manifestData.dataset_revision,
        focus: "branch",
        runId: manifestData.run_id,
        stageId: manifestData.stage_id,
      });
      kernel.selection.set(
        {
          kind: selection.kind,
          label: branchId,
          nodeId: selection.nodeId,
          objectId: null,
          ref: selection,
        },
        moduleId,
      );
    },
    [
      effectiveResultAxisFilters,
      kernel.selection,
      moduleId,
      resultManifest.data,
    ],
  );
  const onAxisFilterChange = useCallback(
    (axisId: string, token: string | null) => {
      const manifestData = resultManifest.data;
      if (!manifestData?.capabilities.server_filtering) return;
      const nextAxisFilters = { ...effectiveResultAxisFilters };
      if (token) nextAxisFilters[axisId] = token;
      else delete nextAxisFilters[axisId];
      setResultAxisFilters(nextAxisFilters);
      setResultAxisFilterDatasetId(manifestData.dataset_id);
      const selection = analysisResultSelectionRef({
        axisFilters: nextAxisFilters,
        datasetId: manifestData.dataset_id,
        datasetRevision: manifestData.dataset_revision,
        focus: Object.keys(nextAxisFilters).length > 0 ? "slice" : "dataset",
        runId: manifestData.run_id,
        stageId: manifestData.stage_id,
      });
      kernel.selection.set(
        {
          kind: selection.kind,
          label: selection.datasetId,
          nodeId: selection.nodeId,
          objectId: null,
          ref: selection,
        },
        moduleId,
      );
    },
    [
      effectiveResultAxisFilters,
      kernel.selection,
      moduleId,
      resultManifest.data,
    ],
  );
  const onAxisDisplayUnitChange = useCallback(
    (axisId: string, unit: string) => {
      const manifestData = resultManifest.data;
      const axis = manifestData?.axes.find((candidate) => candidate.axis_id === axisId);
      if (!axis) return;
      const presentation = analysisResultAxisPresentation(axis);
      if (!presentation.displayUnits.includes(unit)) return;
      setResultAxisDisplayUnits((current) => ({ ...current, [axisId]: unit }));
    },
    [resultManifest.data],
  );
  const onOpenResultAnalysis = useCallback(() => {
    const selectionForAnalysis = resultSelectionForAnalysis(
      resultManifest.data,
      selectedResultSelection,
    );
    if (selectionForAnalysis && selectionForAnalysis !== selectedResultSelection) {
      onSelectResult(selectionForAnalysis);
    }
    void kernel.commands.execute(
      "analysis-plots.open",
      createCommandContext("explorer", kernel, {
        sourceDetail: "results-dataset-browser",
      }),
    );
  }, [kernel, onSelectResult, resultManifest.data, selectedResultSelection]);
  const onPlotResultField = useCallback(
    (selection: AnalysisResultSelectionRef) => {
      const intent = createAnalysisResultFieldOverlayIntent(selection);
      if (!intent) return;
      void kernel.commands.execute(
        analysisResultFieldOverlayAdapter(intent.itemKind).plotCommandId,
        createCommandContext("explorer", kernel, {
          sourceDetail: "results-dataset-browser",
        }),
      );
    },
    [kernel],
  );
  const onInspectResultProvenance = useCallback(() => {
    kernel.layout.setFocusedSlot("panel-right");
  }, [kernel.layout]);

  return (
    <section aria-label="Results" className="fm-results-navigator">
      <header className="fm-results-navigator__header">
        <h2>Results</h2>
        <span data-status={nodes[0]?.status ?? "missing"}>
          {nodes[0]?.status ?? "missing"}
        </span>
      </header>
      {resultDatasetBrowserVisible ? (
        <ResultDatasetBrowser
          branchesPage={verifiedResultBranches}
          branchesResourceStatus={resultBranches.status}
          catalogResourceStatus={resultCatalog.status}
          catalogPage={resultCatalog.data}
          manifest={resultManifest.data}
          manifestResourceStatus={resultManifest.status}
          serverFiltering={resultServerFiltering}
          serverSorting={resultServerSorting}
          model={resultBrowserModel}
          datasetSearch={resultDatasetSearch}
          itemFieldFilter={resultItemFieldFilter}
          itemSort={resultItemSort}
          onCatalogPageChange={(cursor) =>
            setResultCatalogPageState({ cursor, key: resultCatalogPageKey })
          }
          onDatasetSearchChange={onResultDatasetSearchChange}
          axisFilters={effectiveResultAxisFilters}
          axisDisplayUnits={resultAxisDisplayUnits}
          onAxisFilterChange={onAxisFilterChange}
          onAxisDisplayUnitChange={onAxisDisplayUnitChange}
          branchFilter={effectiveResultBranchId}
          onBranchFilterChange={onResultBranchFilterChange}
          onBranchPageChange={(cursor) =>
            setBranchPageState({ cursor, key: resultBranchPageKey })
          }
          followedBranchId={effectiveFollowedBranchId}
          onFollowBranch={onFollowResultBranch}
          onInspectProvenance={onInspectResultProvenance}
          onItemFieldFilterChange={setResultItemFieldFilter}
          itemFrequencyMax={resultItemFrequencyMax}
          itemFrequencyMin={resultItemFrequencyMin}
          itemFilterError={resultItemFilterError}
          itemResidualMax={resultItemResidualMax}
          itemStatusFilter={resultItemStatusFilter}
          onItemFrequencyMaxChange={setResultItemFrequencyMax}
          onItemFrequencyMinChange={setResultItemFrequencyMin}
          onItemResidualMaxChange={setResultItemResidualMax}
          onItemStatusFilterChange={setResultItemStatusFilter}
          onSelect={onSelectResult}
          onItemPageChange={(cursor) =>
            setItemPageState({ cursor, key: resultItemPageKey })
          }
          onItemSortChange={setResultItemSort}
          onOpenAnalysis={onOpenResultAnalysis}
          onPlotField={onPlotResultField}
          onSamplePageChange={(cursor) =>
            setSamplePageState({ cursor, key: resultSamplePageKey })
          }
          itemsPage={verifiedResultItems}
          itemsResourceStatus={resultItems.status}
          samplesPage={verifiedResultSamples}
          samplesResourceStatus={resultSamples.status}
          selectedDatasetId={resultDatasetId}
          selectedSelection={selectedResultSelection}
        />
      ) : (
        <>
          {legacyResultsFallbackEnabled ? (
            <p
              className="fm-results-navigator__compatibility-status"
              role="status"
            >
              Typed result index has no published datasets; showing the bounded
              legacy frequency-domain compatibility view.
            </p>
          ) : null}
          <ResultsNavigatorTree
            nodes={nodes}
            onSelect={onSelect}
            selectedNodeId={selectedNodeId}
          />
        </>
      )}
    </section>
  );
}
