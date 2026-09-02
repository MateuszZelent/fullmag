"use client";

import { useCallback, useEffect, useMemo } from "react";

import {
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultProjectionResource,
} from "@/kernel/resources/analysisResultResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { KernelApi } from "@/kernel/types";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import {
  analysisResultSelectionForProjection,
  analysisResultSelectionRef,
  buildAnalysisResultProjectionChartModel,
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
    () => buildAnalysisResultProjectionChartModel(resultProjection.data),
    [resultProjection.data],
  );
  const onResultProjectionPointSelect = useCallback(
    (entry: AnalysisResultProjectionSelection) => {
      if (!selectedResultSelection || !resultProjection.data) return;
      const selection = analysisResultSelectionRef({
        branchId: entry.branchId ?? undefined,
        datasetId: selectedResultSelection.datasetId,
        datasetRevision: selectedResultSelection.datasetRevision,
        focus: entry.itemId ? "item" : "sample",
        itemId: entry.itemId ?? undefined,
        itemKind: selectedResultSelection.itemKind,
        projectionId: resultProjection.data.projection_id,
        projectionOrdinal: entry.ordinal,
        projectionRevision: resultProjection.data.projection_revision,
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
    [kernel.selection, resultProjection.data, selectedResultSelection],
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
    resource: resultProjection.data,
    selectedSelection: selectedResultSelection,
    selectedProjectionId: resultProjectionId,
    status: resultProjection.status,
  };
}

export function analysisResultSelectionOwnsOverlay(
  selection: AnalysisResultSelectionRef,
  overlay: AnalysisFieldOverlayState,
): boolean {
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
