"use client";

import { useCallback, useMemo, useState } from "react";

import {
  useAnalysisResultAxisValuesResource,
  useAnalysisResultBranchesResource,
  useAnalysisResultDatasetCatalogResource,
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultItemsResource,
  useAnalysisResultSamplesResource,
} from "@/kernel/resources/analysisResultResources";
import type { AnalysisResultPageQuery } from "@/kernel/api/apiTypes";
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

import { ResultsNavigatorTree } from "./ResultsNavigatorTree";
import { ResultDatasetBrowser } from "./ResultDatasetBrowser";
import { buildResultDatasetBrowserModel } from "./resultDatasetBrowserModel";
import {
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

export default function ResultsNavigatorModule({
  kernel,
  moduleId,
}: ModuleProps) {
  const currentRun = useCurrentRunResource();
  const stageExecution = useStageExecutionResource();
  const resultRunId = currentRun.data?.run_id ?? null;
  const [resultDatasetSearch, setResultDatasetSearch] = useState("");
  const [resultItemFieldFilter, setResultItemFieldFilter] = useState<
    "all" | "true" | "false"
  >("all");
  const [resultItemSort, setResultItemSort] = useState("display_index_asc");
  const resultCatalogQuery = useMemo(
    () => ({
      limit: 50,
      sort: "dataset_id_asc",
      ...(resultDatasetSearch.trim()
        ? { search: resultDatasetSearch.trim() }
        : {}),
    }),
    [resultDatasetSearch],
  );
  const resultCatalog = useAnalysisResultDatasetCatalogResource(resultRunId, {
    query: resultCatalogQuery,
  });
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
  const [resultAxisFilterDatasetId, setResultAxisFilterDatasetId] =
    useState<string | null>(null);
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
  const resultAxisQuery = useMemo<AnalysisResultPageQuery>(
    () =>
      Object.fromEntries(
        Object.entries(effectiveResultAxisFilters).map(([axisId, token]) => [
          `coordinate.${axisId}`,
          token,
        ]),
      ) as AnalysisResultPageQuery,
    [effectiveResultAxisFilters],
  );
  const resultAxisFiltersKey = axisFiltersKey(effectiveResultAxisFilters);
  const resultSamplePageKey = `${resultDatasetId ?? "none"}:${selectedResultSampleId ?? "all"}:${resultAxisFiltersKey}`;
  const resultItemPageKey = `${resultSamplePageKey}:${resultItemFieldFilter}:${resultItemSort}`;
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
  const resultManifest = useAnalysisResultDatasetManifestResource(
    resultRunId,
    resultDatasetId,
  );
  const resultAxisId =
    resultManifest.data?.axes.find((axis) =>
      ["outer_sweep", "parameter", "material", "geometry", "field"].includes(
        axis.role,
      ),
    )?.axis_id ?? null;
  const resultAxisValues = useAnalysisResultAxisValuesResource(
    resultRunId,
    resultDatasetId,
    resultAxisId,
    { query: { limit: 256 } },
  );
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
      query: {
        limit: 50,
        ...resultAxisQuery,
        ...(itemCursor ? { cursor: itemCursor } : {}),
        ...(selectedResultSampleId ? { sample_id: selectedResultSampleId } : {}),
        ...(resultItemFieldFilter === "all"
          ? {}
          : { has_field: resultItemFieldFilter === "true" }),
        sort: resultItemSort,
      },
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
        sort: "branch_id_asc",
      },
    },
  );
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const fieldSweep = useFrequencyDomainEigenFieldSweepResource();
  const fmrPeaks = useFrequencyDomainFmrPeaksResource();
  const fmrResonanceFits = useFrequencyDomainFmrResonanceFitsResource();
  const fmrKittelFit = useFrequencyDomainFmrKittelFitResource();
  const response = useFrequencyDomainResponseSweepResource();
  const responseProgress = useFrequencyDomainResponseProgressResource();
  const responseDiagnostics = useFrequencyDomainResponseDiagnosticsResource();
  const selectedNodeId = useSelectionSelector((selection) => selection.nodeId);

  const resultBrowserModel = useMemo(
    () =>
      buildResultDatasetBrowserModel({
        catalog: resultCatalog.data,
        branches: resultBranches.data,
        items: resultItems.data,
        manifest: resultManifest.data,
        samples: resultSamples.data,
        selectedDatasetId: selectedResultDatasetId,
      }),
    [
      resultCatalog.data,
      resultBranches.data,
      resultItems.data,
      resultManifest.data,
      resultSamples.data,
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
  const onAxisFilterChange = useCallback(
    (axisId: string, token: string | null) => {
      const manifestData = resultManifest.data;
      if (!manifestData) return;
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

  return (
    <section aria-label="Results" className="fm-results-navigator">
      <header className="fm-results-navigator__header">
        <h2>Results</h2>
        <span data-status={nodes[0]?.status ?? "missing"}>
          {nodes[0]?.status ?? "missing"}
        </span>
      </header>
      {resultCatalog.data ? (
        <ResultDatasetBrowser
          branchesPage={resultBranches.data}
          manifest={resultManifest.data}
          model={resultBrowserModel}
          datasetSearch={resultDatasetSearch}
          itemFieldFilter={resultItemFieldFilter}
          itemSort={resultItemSort}
          onDatasetSearchChange={setResultDatasetSearch}
          axisFilters={effectiveResultAxisFilters}
          axisValues={resultAxisValues.data}
          onAxisFilterChange={onAxisFilterChange}
          onBranchPageChange={(cursor) =>
            setBranchPageState({ cursor, key: resultBranchPageKey })
          }
          onItemFieldFilterChange={setResultItemFieldFilter}
          onSelect={onSelectResult}
          onItemPageChange={(cursor) =>
            setItemPageState({ cursor, key: resultItemPageKey })
          }
          onItemSortChange={setResultItemSort}
          onSamplePageChange={(cursor) =>
            setSamplePageState({ cursor, key: resultSamplePageKey })
          }
          itemsPage={resultItems.data}
          samplesPage={resultSamples.data}
          selectedDatasetId={resultBrowserModel.selectedDatasetId}
        />
      ) : (
        <ResultsNavigatorTree
          nodes={nodes}
          onSelect={onSelect}
          selectedNodeId={selectedNodeId}
        />
      )}
    </section>
  );
}
