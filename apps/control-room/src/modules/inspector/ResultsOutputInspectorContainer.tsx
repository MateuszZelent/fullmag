"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  resultDatasetIdentity,
  type ResultsSource,
} from "@/kernel/api/resultsBrowser";
import { useKernel } from "@/kernel/KernelContext";
import {
  useResultsArrayResource,
  useResultsFilePreviewResource,
  useResultsSampleResource,
} from "@/kernel/resources/resultsBrowserResources";
import { sessionResourceIdentityKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { returnResultsToLive } from "@/kernel/visualization/returnResultsToLive";
import {
  DEFAULT_SNAPSHOT_VISUALIZATION_APPEARANCE,
  snapshotVisualizationKey,
  type SnapshotVisualizationAppearancePatch,
  type SnapshotVisualizationIdentity,
} from "@/kernel/visualization/SnapshotVisualizationController";
import { useSnapshotVisualization } from "@/kernel/visualization/useSnapshotVisualization";

import {
  clampResultsSampleIndex,
  ResultsOutputInspector,
} from "./panels/ResultsOutputInspector";
import type { InspectorPanelProps } from "./inspectorTypes";

const CURRENT_RESULTS_SOURCE: ResultsSource = Object.freeze({ kind: "current" });

type ResultOutputSelectionRef = Extract<
  NonNullable<Selection["ref"]>,
  { type: "result-output" }
>;

function resultOutputRef(selection: Selection): ResultOutputSelectionRef | null {
  return selection.ref?.type === "result-output" ? selection.ref : null;
}

function errorForResources(...errors: Array<Error | null | undefined>): Error | null {
  return errors.find((error): error is Error => error instanceof Error) ?? null;
}

function pinnedRunId(
  source: ResultsSource,
  runId: string | null,
  sessionKey: string | null,
): string | null {
  if (source.kind === "workspace") {
    return runId || "workspace:" + source.itemId;
  }
  if (!sessionKey) return null;
  return (runId || "current") + "|session=" + sessionKey;
}

function sameSnapshotSeries(
  left: SnapshotVisualizationIdentity,
  right: SnapshotVisualizationIdentity,
): boolean {
  return left.runId === right.runId &&
    left.stageId === right.stageId &&
    left.datasetId === right.datasetId &&
    left.quantityId === right.quantityId &&
    left.revision === right.revision;
}

/**
 * Adapts the selected output node to resource-backed metadata and snapshot
 * controls. Render buffers remain owned by the viewport resource path.
 */
export function ResultsOutputInspectorContainer({
  selection,
}: InspectorPanelProps) {
  const selectedRef = resultOutputRef(selection);
  const selectionKey = selectedRef
    ? selectedRef.nodeId + ":" + selectedRef.revision
    : "none";
  return (
    <ResultsOutputInspectorContainerBody
      key={selectionKey}
      selection={selection}
    />
  );
}

function ResultsOutputInspectorContainerBody({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const resultRef = resultOutputRef(selection);
  const source = resultRef?.source ?? CURRENT_RESULTS_SOURCE;
  const entry = resultRef?.entry ?? null;
  const arrayId = entry?.array_id ?? null;
  const catalogRevision = resultRef?.revision ?? null;
  const arrayResource = useResultsArrayResource(source, arrayId, catalogRevision);
  const array = arrayResource.status === "ready" ? arrayResource.data : null;
  const sessionIdentity = useSessionResourceIdentity();
  const sessionKey = sessionIdentity ? sessionResourceIdentityKey(sessionIdentity) : null;
  const filePreviewResource = useResultsFilePreviewResource(
    source,
    entry?.kind === "file" ? entry.id : null,
    catalogRevision,
  );

  const sampleCount = array && Number.isFinite(array.sample_count)
    ? Math.max(0, Math.floor(array.sample_count))
    : array?.coordinates.length ?? 0;
  const snapshotState = useSnapshotVisualization();
  const savedPlayback = useSavedResultsPlaybackSelection();
  const snapshotController = kernel.snapshotVisualizations;
  const runId = pinnedRunId(
    source,
    resultRef?.runId ?? null,
    sessionKey,
  );
  const baseIdentity = useMemo<SnapshotVisualizationIdentity | null>(() => {
    if (!resultRef || !array || !runId) return null;
    const quantityId =
      array.quantity_id?.trim() ||
      array.quantity_ids?.find((candidate) => candidate.trim())?.trim() ||
      array.id;
    return {
      runId,
      stageId: "results-output",
      datasetId: resultDatasetIdentity(source, array.id),
      quantityId,
      sampleIndex: 0,
      revision: array.revision,
    };
  }, [array, resultRef, runId, source]);
  const preferredSampleIndex = baseIdentity && snapshotController
    ? snapshotController.getPreferredSampleIndex(baseIdentity)
    : null;
  const [sampleIndex, setSampleIndex] = useState<number | null>(null);
  const selectedSampleIndex = clampResultsSampleIndex(
    sampleIndex ?? preferredSampleIndex ?? 0,
    sampleCount,
  );
  const [valuesOpen, setValuesOpen] = useState(false);
  const sampleResource = useResultsSampleResource(
    source,
    valuesOpen ? array : null,
    selectedSampleIndex,
  );
  const identity = useMemo<SnapshotVisualizationIdentity | null>(() => (
    baseIdentity
      ? { ...baseIdentity, sampleIndex: selectedSampleIndex }
      : null
  ), [baseIdentity, selectedSampleIndex]);
  const identityKey = identity ? snapshotVisualizationKey(identity) : null;
  const definition = identityKey
    ? snapshotState.definitions[identityKey] ?? null
    : null;
  const activeDefinition = snapshotState.activeKey
    ? snapshotState.definitions[snapshotState.activeKey] ?? null
    : null;

  useEffect(() => {
    if (!identity || !snapshotController) return;
    snapshotController.ensureDefinition(identity);
  }, [identity, identityKey, snapshotController]);

  const onSampleIndexChange = useCallback(
    (nextSampleIndex: number) => {
      const next = clampResultsSampleIndex(nextSampleIndex, sampleCount);
      setSampleIndex(next);
      if (identity && snapshotController) {
        const nextIdentity = { ...identity, sampleIndex: next };
        snapshotController.rememberSampleIndex(nextIdentity);
        if (
          activeDefinition?.identity &&
          sameSnapshotSeries(activeDefinition.identity, identity)
        ) {
          snapshotController.select(nextIdentity);
        }
      }
    },
    [activeDefinition, identity, sampleCount, setSampleIndex, snapshotController],
  );
  const onLoadTo3D = useCallback(() => {
    if (!identity || !snapshotController || array?.can_visualize_3d !== true) return;
    snapshotController.select(identity);
    kernel.layout.setActiveViewportMainModule("viewport-3d");
    kernel.layout.setFocusedSlot("viewport-main");
  }, [array?.can_visualize_3d, identity, kernel.layout, snapshotController]);
  const onAppearanceChange = useCallback(
    (patch: SnapshotVisualizationAppearancePatch) => {
      if (!identity || !identityKey || !snapshotController) return;
      snapshotController.ensureDefinition(identity, false);
      snapshotController.updateAppearance(identityKey, patch);
    },
    [identity, identityKey, snapshotController],
  );
  const onReturnToLive = useCallback(
    () => returnResultsToLive(kernel),
    [kernel],
  );

  const resourceStatus = entry?.kind === "file"
    ? filePreviewResource.status
    : arrayResource.status;
  const status = resourceStatus === "idle" && array ? "ready" : resourceStatus;
  const error = errorForResources(
    arrayResource.error,
    filePreviewResource.error,
  );
  const canReturnToLive = savedPlayback !== null || snapshotState.activeKey !== null;
  const returnActionLabel = sessionIdentity ? "Return to live" : "Close results";

  return (
    <ResultsOutputInspector
      appearance={definition?.appearance ?? DEFAULT_SNAPSHOT_VISUALIZATION_APPEARANCE}
      array={array}
      canReturnToLive={canReturnToLive}
      entry={entry}
      error={error}
      filePreview={filePreviewResource.status === "ready" ? filePreviewResource.data : null}
      onAppearanceChange={onAppearanceChange}
      onLoadTo3D={onLoadTo3D}
      onReturnToLive={onReturnToLive}
      onSampleIndexChange={onSampleIndexChange}
      returnActionLabel={returnActionLabel}
      sampleIndex={selectedSampleIndex}
      status={status}
      valuesAvailable={array?.can_read_values === true}
      valuesEnabled={valuesOpen}
      valuesError={sampleResource.error}
      valuesStatus={sampleResource.status}
      values={sampleResource.data}
      onValuesOpenChange={setValuesOpen}
    />
  );
}

export default ResultsOutputInspectorContainer;
