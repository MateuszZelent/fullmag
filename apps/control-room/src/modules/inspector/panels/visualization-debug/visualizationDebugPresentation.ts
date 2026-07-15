import type {
  VisualizationDebugDisposition,
  VisualizationDebugIssue,
  VisualizationDebugMemoryRow,
  VisualizationDebugSnapshot,
} from "@/kernel/visualization/visualizationDebugTypes";

import type {
  VisualizationDebugCarrierObservation,
  VisualizationDebugPanelModel,
} from "./VisualizationDebugPanelModel";
import { formatScientific } from "./VisualizationDebugSampleTable";

export function visualizationDebugEmptyStateMessage(
  state: VisualizationDebugPanelModel["state"],
): { title: string; detail: string } | null {
  if (state === "ready") return null;
  if (state === "missing-snapshot") {
    return {
      title: "Loading visualization evidence",
      detail: "Waiting for the active viewport to publish bounded target evidence.",
    };
  }
  if (state === "active-non-3d" || state === "missing-viewport") {
    return {
      title: "No active 3D viewport",
      detail: "Activate the 3D center surface to observe adopted render data.",
    };
  }
  if (state === "target-not-rendered") {
    return {
      title: "Target is not rendered",
      detail: "The active render model contains no carrier for this canonical target.",
    };
  }
  return {
    title: "Unsupported visualization target",
    detail: "Debug evidence is available only for Airbox, object, and object-region Visualization nodes.",
  };
}

export function allObservations(
  model: VisualizationDebugPanelModel,
): VisualizationDebugCarrierObservation[] {
  return model.viewports.flatMap((viewport) =>
    viewport.carriers.flatMap((carrier) => [...carrier.observations]),
  );
}

export function uniqueSnapshots(
  model: VisualizationDebugPanelModel,
): VisualizationDebugSnapshot[] {
  return [...new Set(model.viewports.flatMap((viewport) => [...viewport.snapshots]))];
}

export function latestSnapshotCaptureTime(
  model: VisualizationDebugPanelModel,
): number {
  const captures = model.viewports.flatMap((viewport) =>
    viewport.snapshots.map((snapshot) => snapshot.capturedAtMs),
  );
  return captures.length > 0 ? Math.max(...captures) : 0;
}

export function aggregateDisposition(
  snapshots: readonly VisualizationDebugSnapshot[],
): VisualizationDebugDisposition {
  for (const disposition of ["blocked", "degraded", "unknown", "ready"] as const) {
    if (snapshots.some((snapshot) => snapshot.disposition === disposition)) {
      return disposition;
    }
  }
  return "unknown";
}

export function healthDiagnosis(
  disposition: VisualizationDebugDisposition,
): string {
  if (disposition === "ready") return "Evidence is internally consistent.";
  if (disposition === "degraded") {
    return "Evidence is degraded; inspect warnings below.";
  }
  if (disposition === "blocked") {
    return "Visualization pipeline is blocked; inspect errors below.";
  }
  return "Health is unknown because evidence is incomplete.";
}

export function formatDuration(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = value < 1 ? 3 : value < 100 ? 2 : 0;
  return `${value.toFixed(digits)} ms`;
}

export function formatBytes(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let scaled = Math.max(0, value);
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${index === 0 ? Math.round(scaled) : scaled.toFixed(2)} ${units[index]}`;
}

export function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}

export function formatContext(snapshot: VisualizationDebugSnapshot | null): string {
  if (!snapshot || snapshot.viewport.contextLost == null) return "unknown";
  return snapshot.viewport.contextLost ? "lost" : "available";
}

export function formatDrawingBuffer(
  snapshot: VisualizationDebugSnapshot | null,
): string {
  return snapshot?.viewport.drawingBuffer?.join(" × ") ?? "—";
}

export function formatBackendStats(
  stats: { min: number; max: number; mean: number } | null | undefined,
): string {
  return stats
    ? `${formatScientific(stats.min)} / ${formatScientific(stats.max)} / ${formatScientific(stats.mean)}`
    : "—";
}

interface VisualizationDebugStatisticsRow {
  carrierId: string;
  counts: string;
  key: string;
  max: number | null;
  mean: number | null;
  min: number | null;
  p01: number | null;
  p99: number | null;
  source: string;
  unit: string;
}

export function statisticsRows(
  observations: readonly VisualizationDebugCarrierObservation[],
): VisualizationDebugStatisticsRow[] {
  return observations.flatMap((observation, observationIndex) => {
    const rows: VisualizationDebugStatisticsRow[] = [];
    const backend = observation.backendMeta?.stats;
    if (backend) {
      rows.push({
        carrierId: observation.carrier.carrierId,
        counts: "—",
        key: `${observationIndex}:backend-meta`,
        max: backend.max,
        mean: backend.mean,
        min: backend.min,
        p01: null,
        p99: null,
        source: "backend-meta",
        unit: observation.backendMeta?.unit ?? "unknown",
      });
    }
    rows.push(
      ...observation.carrier.statistics.map((stats, statsIndex) => ({
        carrierId: observation.carrier.carrierId,
        counts: `${stats.finiteCount} / ${stats.nonFiniteCount} / ${stats.zeroCount}`,
        key: `${observationIndex}:${stats.source}:${statsIndex}`,
        max: stats.max,
        mean: stats.mean,
        min: stats.min,
        p01: stats.p01,
        p99: stats.p99,
        source: stats.source,
        unit: observation.backendMeta?.unit ?? "unknown",
      })),
    );
    return rows;
  });
}

export function memoryGroups(model: VisualizationDebugPanelModel) {
  const snapshots = uniqueSnapshots(model);
  const rows: Array<VisualizationDebugMemoryRow & { renderKey: string }> =
    snapshots.flatMap((snapshot, snapshotIndex) => [
      ...snapshot.sharedMemory.map((row, rowIndex) => ({
        ...row,
        renderKey: memoryRenderKey([
          "shared",
          snapshot.viewport.viewportId,
          snapshot.target.id,
          snapshotIndex,
          row.source,
          row.id,
          rowIndex,
        ]),
      })),
      ...snapshot.carriers.flatMap((carrier, carrierIndex) =>
        carrier.memory.map((row, rowIndex) => ({
          ...row,
          renderKey: memoryRenderKey([
            "carrier",
            snapshot.viewport.viewportId,
            snapshot.target.id,
            snapshotIndex,
            carrier.carrierId,
            carrierIndex,
            row.source,
            row.id,
            rowIndex,
          ]),
        })),
      ),
    ]).concat(
    allObservations(model).flatMap((observation, observationIndex) =>
      observation.wireByteLength === null
        ? []
        : [{
            byteLength: observation.wireByteLength,
            id: `wire:${observation.carrier.carrierId}`,
            label: "Exact decoded wire transfer",
            ownership: "estimated" as const,
            renderKey: memoryRenderKey([
              "wire",
              observation.snapshot.viewport.viewportId,
              observation.snapshot.target.id,
              observation.carrier.carrierId,
              observation.carrier.request.resourceKey,
              observationIndex,
            ]),
            source: "transport" as const,
          }],
    ),
  );
  return (["owned", "referenced", "shared", "estimated"] as const).map(
    (ownership) => {
      const groupRows = rows.filter((row) => row.ownership === ownership);
      return {
        ownership,
        rows: groupRows,
        total: groupRows.every((row) => row.byteLength != null)
          ? groupRows.reduce((sum, row) => sum + (row.byteLength ?? 0), 0)
          : null,
      };
    },
  );
}

function memoryRenderKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

export function allIssues(
  model: VisualizationDebugPanelModel,
): VisualizationDebugIssue[] {
  return [...model.issues];
}
