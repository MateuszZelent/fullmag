"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useKernel } from "@/kernel/KernelContext";
import type { SavedPlaybackResource } from "@/kernel/api/savedResultsPlayback";
import type {
  ResultsArray,
  ResultsFdmGeometry,
  ResultsSource,
} from "@/kernel/api/resultsBrowser";
import { parseResultDatasetIdentity } from "@/kernel/api/resultsBrowser";
import {
  useResultsArrayResource,
  useResultsGeometryResource,
  useResultsSampleResource,
} from "@/kernel/resources/resultsBrowserResources";
import { sessionResourceIdentityKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";

import { formatResultsSampleOrdinal } from "@/kernel/results-browser/resultsSampleLabels";
import { useResultsHistoryExitOwner } from "@/kernel/visualization/ResultsHistoryExitOwnerContext";
import { returnResultsToLive } from "@/kernel/visualization/returnResultsToLive";
import { useSnapshotVisualization } from "@/kernel/visualization/useSnapshotVisualization";
import { formatTooltipValue } from "@/shared/analysis-charts/scientificChartFormatting";
import { Button } from "@/shared/ui/Button";
import { scalarColorPaletteGradientCss } from "@/shared/visualization/scalarColorPalette";

import {
  SavedFieldCanvas,
  type SavedFieldCanvasGeometry,
} from "./SavedResultsPlaybackViewport";
import {
  presentResultsSnapshot,
} from "./model/resultsSnapshotPresentation";
import {
  canUseRetainedResultsSnapshotFrame,
  resultsSnapshotFrameAppearanceKey,
  resultsSnapshotFrameSeriesKey,
  ResultsSnapshotFrameRetentionStore,
} from "./model/resultsSnapshotFrameRetention";
import {
  savedGridGeometry,
  savedSurfaceGeometry,
} from "./model/savedResultsPlaybackModel";

const CURRENT_SOURCE: ResultsSource = Object.freeze({ kind: "current" });

interface SnapshotGeometryResult {
  geometry: SavedFieldCanvasGeometry | null;
  nodeCount: number | null;
  activeNodes: Uint8Array | null;
  error: string | null;
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return null;
}

function formatNumber(value: number): string {
  return Number.isFinite(value)
    ? formatTooltipValue(value, "")
    : "Unavailable";
}

function coordinateCaption(array: ResultsArray, sampleIndex: number): string {
  const coordinate = array.coordinates.find(
    (candidate) => candidate.sample_index === sampleIndex,
  );
  if (!coordinate) {
    return "Coordinate unavailable";
  }
  const value = coordinate.value;
  if (coordinate.kind === "physical_time") {
    return typeof value === "number" && Number.isFinite(value)
      ? `Physical time ${formatNumber(value * 1e9)} ns`
      : "Coordinate unavailable";
  }
  const acceptedStep = (
    coordinate as typeof coordinate & { accepted_step?: string | null }
  ).accepted_step;
  if (typeof acceptedStep === "string" && acceptedStep.trim()) {
    return `Accepted step ${acceptedStep}`;
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? `Accepted step ${value}`
    : "Coordinate unavailable";
}

function validFdmGeometry(geometry: ResultsFdmGeometry): string | null {
  if (geometry.cells_xyz.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    return "Saved FDM geometry has invalid cell bounds.";
  }
  if (
    geometry.cell_size_m.some((value) => !Number.isFinite(value) || value <= 0) ||
    geometry.origin_m.some((value) => !Number.isFinite(value))
  ) {
    return "Saved FDM geometry contains non-finite dimensions.";
  }
  return null;
}

function minimalSavedPlaybackResource(
  geometry: ResultsFdmGeometry,
  revision: string,
): SavedPlaybackResource {
  return {
    schema: "fullmag.saved_playback.v1",
    revision,
    name: "results-snapshot",
    stages: [],
    grid_cells_xyz: [...geometry.cells_xyz],
    cell_size_m: [...geometry.cell_size_m],
    origin_m: [...geometry.origin_m],
  };
}

function buildFdmGeometry(
  geometry: ResultsFdmGeometry,
  revision: string,
): SnapshotGeometryResult {
  const validationError = validFdmGeometry(geometry);
  if (validationError) {
    return { geometry: null, nodeCount: null, activeNodes: null, error: validationError };
  }
  try {
    const renderGeometry = savedGridGeometry(
      minimalSavedPlaybackResource(geometry, revision),
    );
    return {
      geometry: renderGeometry,
      nodeCount: renderGeometry.count,
      activeNodes: null,
      error: null,
    };
  } catch (error) {
    return {
      geometry: null,
      nodeCount: null,
      activeNodes: null,
      error: errorMessage(error) ?? "Saved FDM geometry is invalid.",
    };
  }
}

export interface ResultsSnapshotViewportProps {
  className?: string;
}

export function ResultsSnapshotViewport({
  className = "fm-results-snapshot-viewport",
}: ResultsSnapshotViewportProps) {
  const kernel = useKernel();
  const resultsHistoryExitOwner = useResultsHistoryExitOwner();
  const snapshotState = useSnapshotVisualization();
  const activeKey = snapshotState.activeKey;
  const definition = activeKey
    ? snapshotState.definitions[activeKey] ?? null
    : null;
  const identity = definition?.identity ?? null;
  const datasetId = identity?.datasetId ?? null;
  const identityRevision = identity?.revision ?? null;
  const parsedDataset = useMemo(
    () => (datasetId ? parseResultDatasetIdentity(datasetId) : null),
    [datasetId],
  );
  const datasetIdentityError =
    identity && !parsedDataset ? "Saved dataset identity is unsupported." : null;
  const source = parsedDataset?.source ?? CURRENT_SOURCE;
  const sessionIdentity = useSessionResourceIdentity();
  const sessionIdentityKey = sessionIdentity
    ? sessionResourceIdentityKey(sessionIdentity)
    : null;
  const identityRunId = identity?.runId ?? null;
  const previousSessionIdentityKeyRef = useRef(sessionIdentityKey);
  useEffect(() => {
    const previous = previousSessionIdentityKeyRef.current;
    const pinnedSessionSuffix = sessionIdentityKey
      ? "|session=" + sessionIdentityKey
      : null;
    const identityPinnedToSession =
      source.kind !== "current" ||
      (pinnedSessionSuffix !== null &&
        identityRunId?.endsWith(pinnedSessionSuffix) === true);
    if (
      source.kind === "current" &&
      identity !== null &&
      (!identityPinnedToSession ||
        (previous !== null && previous !== sessionIdentityKey))
    ) {
      kernel.snapshotVisualizations?.returnToLive();
    }
    previousSessionIdentityKeyRef.current = sessionIdentityKey;
  }, [identity, identityRunId, kernel.snapshotVisualizations, sessionIdentityKey, source.kind]);
  const arrayId = parsedDataset?.arrayId ?? null;
  const catalogRevision = identityRevision;
  const arrayResource = useResultsArrayResource(source, arrayId, catalogRevision);
  const array = arrayResource.data;
  const sampleIndex = identity?.sampleIndex ?? 0;
  const sampleResource = useResultsSampleResource(source, array, sampleIndex);
  const frameSeriesKey =
    identity && parsedDataset
      ? resultsSnapshotFrameSeriesKey({
          sessionIdentityKey,
          source: parsedDataset.source,
          identity,
        })
      : null;
  const frameAppearanceKey = definition
    ? resultsSnapshotFrameAppearanceKey(definition.appearance)
    : null;
  const frameRetentionStore = useMemo(
    () => new ResultsSnapshotFrameRetentionStore(),
    [],
  );
  const retainedFrameSnapshot = useSyncExternalStore(
    frameRetentionStore.subscribe,
    frameRetentionStore.getSnapshot,
    frameRetentionStore.getServerSnapshot,
  );
  const retainedFrame = canUseRetainedResultsSnapshotFrame(
    retainedFrameSnapshot,
    frameSeriesKey,
    definition?.appearance.visible === true,
    sampleIndex,
  )
    ? retainedFrameSnapshot
    : null;

  const femGeometryResource = useResultsGeometryResource(source, array);

  const arrayGeometry = array?.geometry ?? null;
  const arrayLoaded = array !== null;
  const arrayCanVisualize3d = array?.can_visualize_3d ?? false;
  const arrayReason = array?.reason ?? null;
  const geometryResult = useMemo<SnapshotGeometryResult>(() => {
    if (!arrayLoaded || !identityRevision) {
      return { geometry: null, nodeCount: null, activeNodes: null, error: null };
    }
    if (!arrayCanVisualize3d) {
      return {
        geometry: null,
        nodeCount: null,
        activeNodes: null,
        error: arrayReason ?? "Saved array is not verified for 3-D visualization.",
      };
    }
    if (!arrayGeometry) {
      return {
        geometry: null,
        nodeCount: null,
        activeNodes: null,
        error: arrayReason ?? "Saved array has no persisted 3-D geometry mapping.",
      };
    }
    if (arrayGeometry.kind === "fdm") {
      return buildFdmGeometry(arrayGeometry, identityRevision);
    }
    if (!arrayGeometry.fem_mesh || arrayGeometry.playback_geometry_sha256 !== arrayGeometry.fem_mesh.geometry_sha256) {
      return { geometry: null, nodeCount: null, activeNodes: null, error: "Saved FEM geometry revision differs from the selected field mapping." };
    }
    const mesh = femGeometryResource.data;
    if (!mesh) {
      return {
        geometry: null,
        nodeCount: null,
        activeNodes: null,
        error: null,
      };
    }
    if (
      mesh.topology.nodeCount !== arrayGeometry.node_count ||
      (mesh.topology.cellCount ?? mesh.topology.elementCount) !== arrayGeometry.cell_count ||
      mesh.support.nodeCount !== arrayGeometry.node_count
    ) {
      return {
        geometry: null,
        nodeCount: null,
        activeNodes: null,
        error: "Saved FEM topology/support counts do not match the results array.",
      };
    }
    try {
      const renderGeometry = savedSurfaceGeometry(mesh.topology, mesh.support);
      return {
        geometry: renderGeometry,
        nodeCount: renderGeometry.count,
        activeNodes: renderGeometry.activeNodes,
        error: null,
      };
    } catch (error) {
      return {
        geometry: null,
        nodeCount: null,
        activeNodes: null,
        error: errorMessage(error) ?? "Saved FEM geometry is invalid.",
      };
    }
  }, [
    arrayLoaded,
    arrayCanVisualize3d,
    arrayReason,
    arrayGeometry,
    femGeometryResource.data,
    identityRevision,
  ]);

  const presentationResult = useMemo(() => {
    if (!array || !sampleResource.data || !geometryResult.nodeCount || !definition) {
      return null;
    }
    return presentResultsSnapshot({
      values: sampleResource.data,
      componentCount: array.component_count ?? 0,
      fieldLayout: array.field_layout,
      nodeCount: geometryResult.nodeCount,
      sampleShape: array.shape.slice(1),
      activeNodes: geometryResult.activeNodes,
      appearance: definition.appearance,
    });
  }, [array, definition, geometryResult, sampleResource.data]);

  const resourceError =
    arrayResource.error?.message ??
    sampleResource.error?.message ??
    femGeometryResource.error?.message;
  const sampleIndexError =
    array &&
    (!Number.isSafeInteger(sampleIndex) ||
      sampleIndex < 0 ||
      sampleIndex >= array.sample_count)
      ? `Saved sample index ${sampleIndex} is outside the published array.`
      : null;
  const error =
    datasetIdentityError ??
    geometryResult.error ??
    sampleIndexError ??
    resourceError ??
    presentationResult?.error ??
    null;
  const ready =
    Boolean(presentationResult?.presentation && geometryResult.geometry) &&
    arrayResource.status === "ready" &&
    sampleResource.status === "ready" &&
    !error;
  const readyPresentation = ready ? presentationResult?.presentation ?? null : null;
  useEffect(() => {
    if (
      frameSeriesKey === null ||
      frameAppearanceKey === null ||
      definition?.appearance.visible !== true
    ) {
      frameRetentionStore.clear();
      return;
    }
    if (retainedFrameSnapshot && retainedFrameSnapshot.seriesKey !== frameSeriesKey) {
      frameRetentionStore.clear();
    }
    if (!readyPresentation?.colors || readyPresentation.colors.length === 0) return;
    if (
      retainedFrameSnapshot?.seriesKey === frameSeriesKey &&
      retainedFrameSnapshot.appearanceKey === frameAppearanceKey &&
      retainedFrameSnapshot.sampleIndex === sampleIndex &&
      retainedFrameSnapshot.colors === readyPresentation.colors &&
      retainedFrameSnapshot.range.min === readyPresentation.range.min &&
      retainedFrameSnapshot.range.max === readyPresentation.range.max
    ) {
      return;
    }
    frameRetentionStore.commit({
      seriesKey: frameSeriesKey,
      appearanceKey: frameAppearanceKey,
      sampleIndex,
      coordinateCaption: array
        ? coordinateCaption(array, sampleIndex)
        : "Coordinate unavailable",
      legendComponent: array?.component_count === 1
        ? "scalar"
        : definition?.appearance.component ?? "z",
      palette: definition?.appearance.palette ?? "coolwarm",
      colors: readyPresentation.colors,
      range: readyPresentation.range,
    });
  }, [
    array,
    definition?.appearance.component,
    definition?.appearance.palette,
    definition?.appearance.visible,
    frameAppearanceKey,
    frameSeriesKey,
    frameRetentionStore,
    retainedFrameSnapshot,
    readyPresentation,
    sampleIndex,
  ]);
  useEffect(
    () => () => frameRetentionStore.clear(),
    [frameRetentionStore],
  );
  const status = !identity ? "idle" : error ? "error" : ready ? "ready" : "loading";
  const returnToLive = useCallback(() => returnResultsToLive(kernel), [kernel]);
  const exitLabel = sessionIdentity ? "Return to live" : "Close results";

  if (!identity || !definition) {
    return (
      <section
        aria-label="Saved results 3D viewport"
        className={className}
        data-results-snapshot-index=""
        data-results-snapshot-displayed-index=""
        data-results-snapshot-status="idle"
      >
        <p role="status">No saved result snapshot is selected.</p>
      </section>
    );
  }

  const quantity = array?.quantity_id ?? identity.quantityId;
  const unit = array?.unit ?? "Unit not recorded";
  const requestedCaptionCoordinate = array
    ? coordinateCaption(array, sampleIndex)
    : "Coordinate unavailable";
  const requestedSampleLabel = formatResultsSampleOrdinal(
    sampleIndex,
    array?.sample_count,
  );
  const displayedSampleIndex = readyPresentation?.colors
    ? sampleIndex
    : retainedFrame?.sampleIndex ?? null;
  const displayedCaptionCoordinate =
    displayedSampleIndex === null
      ? "Unavailable"
      : readyPresentation?.colors
        ? array
          ? coordinateCaption(array, displayedSampleIndex)
          : "Coordinate unavailable"
        : retainedFrame?.coordinateCaption ?? "Coordinate unavailable";
  const displayedSampleLabel = displayedSampleIndex === null
    ? "Sample unavailable"
    : formatResultsSampleOrdinal(displayedSampleIndex, array?.sample_count);
  const displayedRange = readyPresentation?.colors
    ? readyPresentation.range
    : retainedFrame?.range ?? null;
  const canvasColors = readyPresentation?.colors ?? retainedFrame?.colors ?? null;
  const canvasFrameIndex = displayedSampleIndex ?? sampleIndex;
  const displayedLegendComponent = readyPresentation?.colors
    ? array?.component_count === 1
      ? "scalar"
      : definition.appearance.component
    : retainedFrame?.legendComponent ?? definition.appearance.component;
  const displayedPalette = readyPresentation?.colors
    ? definition.appearance.palette
    : retainedFrame?.palette ?? definition.appearance.palette;
  const requestedDiffers = !ready || displayedSampleIndex !== sampleIndex;

  return (
    <section
      aria-label="Saved results 3D viewport"
      className={className}
      data-results-snapshot-index={sampleIndex}
      data-results-snapshot-displayed-index={displayedSampleIndex ?? ""}
      data-results-snapshot-status={status}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 320, position: "relative" }}
    >
      <header
        className="fm-results-snapshot-caption"
        role="status"
        style={{ background: "var(--fm-bg-panel)", color: "var(--fm-text-primary)", padding: "8px 12px" }}
      >
        Historical snapshot · {quantity} · Displayed: {displayedSampleLabel} ({displayedCaptionCoordinate}) · {unit}
        {requestedDiffers ? ` · Requested: ${requestedSampleLabel} (${requestedCaptionCoordinate})` : null}
        {error ? <span role="alert"> · {error}</span> : !ready ? " · Loading saved output…" : null}
        {resultsHistoryExitOwner === null ? (
          <Button size="sm" type="button" variant="secondary" onClick={returnToLive}>
            {exitLabel}
          </Button>
        ) : null}
      </header>

      {geometryResult.geometry ? (
        <SavedFieldCanvas
          className="fm-results-snapshot-canvas"
          colors={canvasColors}
          diagnosticRecorder={kernel.diagnosticRecorder}
          frameIndex={canvasFrameIndex}
          geometry={geometryResult.geometry}
          style={{ minHeight: 260 }}
        />
      ) : null}

      {displayedRange && canvasColors ? (
        <div
          aria-label="Saved result color scale"
          className="fm-results-snapshot-legend flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-fm-xs"
          style={{ background: "var(--fm-bg-panel)", color: "var(--fm-text-primary)", padding: "8px 12px" }}
        >
          {formatNumber(displayedRange.min)}
          <span
            aria-hidden="true"
            className="fm-results-snapshot-gradient max-w-full shrink"
            style={{ background: scalarColorPaletteGradientCss(displayedPalette), display: "inline-block", height: 12, margin: "0 8px", width: 180 }}
          />
          {formatNumber(displayedRange.max)} · {displayedLegendComponent} · {displayedPalette}
        </div>
      ) : null}
    </section>
  );
}

export default ResultsSnapshotViewport;
