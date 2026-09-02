"use client";

import { useCallback, useEffect, useMemo } from "react";

import {
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultProjectionResource,
} from "@/kernel/resources/analysisResultResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { KernelApi } from "@/kernel/types";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { isAnalysisResultFieldOverlayIntent } from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import {
  analysisResultSelectionForProjection,
  analysisResultSelectionRef,
  buildAnalysisResultProjectionChartModel,
  type AnalysisResultDatasetManifestResource,
  type AnalysisResultProjectionResource,
  type AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";

import type {
  AnalysisResultProjectionSelection,
  AnalysisResultProjectionSurfaceProps,
} from "./components/AnalysisResultProjectionSurface";

export function useAnalysisResultProjectionController(
  kernel: KernelApi,
): AnalysisResultProjectionSurfaceProps | undefined {
  const selectedResultSelection = useSelectionSelector(
    (selection): AnalysisResultSelectionRef | null => {
      const ref = selection.ref;
      return ref?.type === "analysis-result" ? ref : null;
    },
  );
  const resultManifest = useAnalysisResultDatasetManifestResource(
    selectedResultSelection?.runId,
    selectedResultSelection?.datasetId,
  );
  const availableProjectionIds = resultManifest.data?.projections.map(
    (projection) => projection.projection_id,
  ) ?? [];
  const requestedProjectionId = selectedResultSelection?.projectionId ?? null;
  const resultProjectionId =
    requestedProjectionId &&
    (availableProjectionIds.length === 0 ||
      availableProjectionIds.includes(requestedProjectionId))
      ? requestedProjectionId
      : availableProjectionIds[0] ?? null;
  const resultProjection = useAnalysisResultProjectionResource(
    selectedResultSelection?.runId,
    selectedResultSelection?.datasetId,
    resultProjectionId,
  );
  const renderableResultProjection =
    analysisResultProjectionMatchesSelection(
      resultProjection.data,
      selectedResultSelection,
      resultManifest.data,
    )
      ? resultProjection.data
      : null;
  useEffect(() => {
    if (!selectedResultSelection) return;
    const activeOverlay = kernel.analysisFieldOverlay.getSnapshot();
    if (
      activeOverlay &&
      !analysisResultSelectionOwnsOverlay(selectedResultSelection, activeOverlay)
    ) {
      kernel.analysisFieldOverlay.clear();
    }
  }, [kernel.analysisFieldOverlay, selectedResultSelection]);
  const resultProjectionModel = useMemo(
    () =>
      buildAnalysisResultProjectionChartModel(
        renderableResultProjection,
        resultManifest.data?.product_kind ?? null,
      ),
    [renderableResultProjection, resultManifest.data?.product_kind],
  );
  const onResultProjectionPointSelect = useCallback(
    (entry: AnalysisResultProjectionSelection) => {
      if (!selectedResultSelection || !renderableResultProjection) return;
      const preservesFieldIdentity =
        entry.itemId === selectedResultSelection.itemId &&
        entry.sampleId === selectedResultSelection.sampleId;
      const selection = analysisResultSelectionRef({
        branchId: entry.branchId ?? undefined,
        datasetId: selectedResultSelection.datasetId,
        datasetRevision: selectedResultSelection.datasetRevision,
        ...(preservesFieldIdentity
          ? {
              displayIndex: selectedResultSelection.displayIndex,
              fieldId: selectedResultSelection.fieldId,
              fieldRef: selectedResultSelection.fieldRef,
              fieldRevision: selectedResultSelection.fieldRevision,
              sampleIndex: selectedResultSelection.sampleIndex,
            }
          : {}),
        focus: entry.itemId ? "item" : "sample",
        itemId: entry.itemId ?? undefined,
        itemKind: entry.itemId
          ? entry.itemKind ?? selectedResultSelection.itemKind
          : undefined,
        ...(selectedResultSelection.axisFilters
          ? { axisFilters: selectedResultSelection.axisFilters }
          : {}),
        projectionId: renderableResultProjection.projection_id,
        projectionOrdinal: entry.ordinal,
        projectionRevision: renderableResultProjection.projection_revision,
        runId: selectedResultSelection.runId,
        sampleId: entry.sampleId ?? undefined,
        stageId: selectedResultSelection.stageId,
      });
      kernel.selection.set(
        {
          kind: selection.kind,
          label: selection.itemId ?? selection.sampleId ?? selection.datasetId,
          nodeId: selection.nodeId,
          objectId: null,
          ref: selection,
        },
        "analysis-plots",
      );
    },
    [kernel.selection, renderableResultProjection, selectedResultSelection],
  );
  const onResultProjectionSelect = useCallback(
    (projectionId: string) => {
      if (!selectedResultSelection) return;
      const selection = analysisResultSelectionForProjection(
        selectedResultSelection,
        projectionId,
      );
      kernel.selection.set(
        {
          kind: selection.kind,
          label: selection.itemId ?? selection.sampleId ?? selection.datasetId,
          nodeId: selection.nodeId,
          objectId: null,
          ref: selection,
        },
        "analysis-plots",
      );
    },
    [kernel.selection, selectedResultSelection],
  );

  if (!selectedResultSelection) return undefined;
  return {
    kernel,
    model: resultProjectionModel,
    onProjectionSelect: onResultProjectionSelect,
    onPointSelect: onResultProjectionPointSelect,
    projections: resultManifest.data?.projections ?? [],
    productKind: resultManifest.data?.product_kind ?? null,
    resource: renderableResultProjection,
    selectedSelection: selectedResultSelection,
    selectedProjectionId: resultProjectionId,
    status: resultProjection.status,
  };
}

export function analysisResultProjectionMatchesSelection(
  projection:
    | Pick<
        AnalysisResultProjectionResource,
        "dataset_id" | "dataset_revision" | "run_id"
      >
    | null
    | undefined,
  selection:
    | Pick<AnalysisResultSelectionRef, "datasetId" | "datasetRevision" | "runId">
    | null
    | undefined,
  manifest:
    | Pick<
        AnalysisResultDatasetManifestResource,
        "dataset_id" | "dataset_revision" | "run_id"
      >
    | null
    | undefined,
): boolean {
  return Boolean(
    projection &&
      selection &&
      manifest &&
      projection.run_id === selection.runId &&
      projection.dataset_id === selection.datasetId &&
      projection.dataset_revision === selection.datasetRevision &&
      projection.run_id === manifest.run_id &&
      projection.dataset_id === manifest.dataset_id &&
      projection.dataset_revision === manifest.dataset_revision,
  );
}

export function analysisResultSelectionOwnsOverlay(
  selection: AnalysisResultSelectionRef,
  overlay: AnalysisFieldOverlayState,
): boolean {
  if (overlay.analysisResultFieldIntent) {
    const intent = overlay.analysisResultFieldIntent;
    return Boolean(
      isAnalysisResultFieldOverlayIntent(intent) &&
        intent.analysisRunId === selection.runId &&
        intent.analysisStageId === selection.stageId &&
        intent.datasetId === selection.datasetId &&
        intent.datasetRevision === selection.datasetRevision &&
        intent.sampleId === selection.sampleId &&
        intent.itemId === selection.itemId &&
        intent.itemKind === selection.itemKind &&
        intent.fieldId === selection.fieldId &&
        intent.fieldRevision === selection.fieldRevision &&
        intent.fieldRef.resource_key === selection.fieldRef?.resource_key &&
        intent.fieldRef.mesh_ref?.mesh_id === selection.fieldRef?.mesh_ref?.mesh_id &&
        intent.fieldRef.mesh_ref?.mesh_revision ===
          selection.fieldRef?.mesh_ref?.mesh_revision &&
        intent.fieldRef.mesh_ref?.topology_fingerprint ===
          selection.fieldRef?.mesh_ref?.topology_fingerprint,
    );
  }
  const intent = overlay.modeIntent;
  return Boolean(
    intent &&
      intent.analysisRunId === selection.runId &&
      intent.analysisStageId === selection.stageId &&
      intent.sampleId === selection.sampleId &&
      intent.modeId === selection.itemId &&
      intent.fieldId === selection.fieldId,
  );
}
