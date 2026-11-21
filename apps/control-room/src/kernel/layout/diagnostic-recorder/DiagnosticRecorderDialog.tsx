"use client";

import {
  Copy,
  Download,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

import type { KernelApi } from "@/kernel/types";
import { serializeDiagnosticArtifactJson } from "@/kernel/performance/diagnostic-recorder/diagnosticArtifactExport";
import type {
  DiagnosticAnyRecord,
  DiagnosticRecorderProfile,
  DiagnosticViewport3DBuildLaneSummary,
  DiagnosticViewport3DVisibleRevisionSummary,
  DiagnosticViewport3DVisibleRevisionTarget,
  DiagnosticViewport3DWorkerPoolRecord,
} from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";
import { useDiagnosticRecorderSnapshot } from "@/kernel/performance/diagnostic-recorder/useDiagnosticRecorderSnapshot";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/shared/ui/Tabs";

type CopyState = "copied" | "failed" | "idle";

interface DiagnosticRecorderDialogProps {
  kernel: KernelApi;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const PROFILE_OPTIONS: DiagnosticRecorderProfile[] = [
  "boot",
  "session",
  "viewport-3d",
  "memory-leak",
  "forensic",
];

/**
 * The recorder is read only while its dialog is open. Mounting the content
 * subscribes to the recorder store and exports the full artifact on every
 * record; doing that for a closed dialog re-rendered the menu bar for every
 * performance entry and starved concurrent renders of the workspace.
 */
export function DiagnosticRecorderDialog(props: DiagnosticRecorderDialogProps) {
  if (!props.open) return null;
  return <DiagnosticRecorderDialogContent {...props} />;
}

function DiagnosticRecorderDialogContent({
  kernel,
  onOpenChange,
  open,
}: DiagnosticRecorderDialogProps) {
  const snapshot = useDiagnosticRecorderSnapshot(kernel.diagnosticRecorder);
  const artifact = kernel.diagnosticRecorder.exportArtifact();
  const [profile, setProfile] = useState<DiagnosticRecorderProfile>(
    snapshot.profile,
  );
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyResetTimerRef = useRef<number | null>(null);

  const startRecording = () => {
    kernel.diagnosticRecorder.start(profile);
  };
  const stopRecording = () => {
    kernel.diagnosticRecorder.stop();
  };
  const clearRecording = () => {
    kernel.diagnosticRecorder.clear();
  };
  const copySuspectReport = useCallback(async () => {
    try {
      await writeClipboardText(artifact.suspectReport.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyResetTimerRef.current = null;
    }, 1_800);
  }, [artifact.suspectReport.text]);
  const downloadJsonArtifact = () => {
    downloadTextFile({
      filename: `fullmag-diagnostics-${Date.now()}-${snapshot.scenario}.json`,
      mimeType: "application/json",
      text: serializeDiagnosticArtifactJson(artifact),
    });
  };

  const slowestRecord = snapshot.summary.slowestRecord;
  const viewportRecordCount = snapshot.streams.viewport3d.length;
  const viewportBuildRecordCount = snapshot.streams.viewport3dBuild.length;
  const viewportWorkerPoolRecords = latestWorkerPoolRecords(
    snapshot.streams.viewport3dWorkerPools,
  );
  const consoleErrorCount = snapshot.streams.console.filter(
    (record) => record.level === "error",
  ).length;
  const memoryBytes = latestMemoryBytes(snapshot.streams.memory);
  const viewport3dBuildSummary = artifact.viewport3dBuildSummary;
  const viewport3dVisibleRevisionSummary =
    artifact.viewport3dVisibleRevisionSummary;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="fm-diagnostic-recorder-description"
        className="fm-diagnostic-recorder"
      >
        <DialogHeader>
          <DialogTitle>Diagnostic Recorder</DialogTitle>
          <DialogDescription
            id="fm-diagnostic-recorder-description"
            className="fm-visually-hidden"
          >
            Fullmag frontend performance recorder.
          </DialogDescription>
          <DialogClose asChild>
            <button
              aria-label="Close diagnostic recorder"
              className="fm-diagnostic-recorder__close"
              type="button"
            >
              <X size={16} />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="fm-diagnostic-recorder__summary">
          <Metric label="Recording" value={snapshot.recording ? "on" : "off"} />
          <Metric label="Profile" value={snapshot.profile} />
          <Metric label="Records" value={String(snapshot.summary.recordCount)} />
          <Metric
            label="Critical"
            tone={snapshot.summary.criticalCount > 0 ? "critical" : "default"}
            value={String(snapshot.summary.criticalCount)}
          />
          <Metric label="Dropped" value={String(snapshot.droppedCount)} />
          <Metric label="Memory" value={formatBytes(memoryBytes)} />
        </div>

        <div className="fm-diagnostic-recorder__toolbar">
          <label className="fm-diagnostic-recorder__profile">
            <span>Profile</span>
            <select
              value={profile}
              onChange={(event) =>
                setProfile(event.target.value as DiagnosticRecorderProfile)
              }
            >
              {PROFILE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <div className="fm-diagnostic-recorder__toolbar-actions">
            {snapshot.recording ? (
              <Button size="sm" type="button" onClick={stopRecording}>
                <Square size={14} aria-hidden="true" />
                Stop
              </Button>
            ) : (
              <Button size="sm" type="button" onClick={startRecording}>
                <Play size={14} aria-hidden="true" />
                Start
              </Button>
            )}
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={clearRecording}
            >
              <Trash2 size={14} aria-hidden="true" />
              Clear
            </Button>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={copySuspectReport}
            >
              <Copy size={14} aria-hidden="true" />
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy report"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={downloadJsonArtifact}
            >
              <Download size={14} aria-hidden="true" />
              Export JSON
            </Button>
          </div>
        </div>

        <Tabs defaultValue="overview" className="fm-diagnostic-recorder__tabs">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="startup">Startup</TabsTrigger>
            <TabsTrigger value="main-thread">Main Thread</TabsTrigger>
            <TabsTrigger value="requests">Requests</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="viewport-3d">Viewport 3D</TabsTrigger>
            <TabsTrigger value="build-engine">Build Engine</TabsTrigger>
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="export">Export</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="fm-diagnostic-recorder__panel">
              <Metric
                label="Slowest"
                value={
                  slowestRecord
                    ? `${slowestRecord.name} ${formatMs(slowestRecord.durationMs)}`
                    : "n/a"
                }
              />
              <Metric
                label="Warnings"
                value={String(snapshot.summary.warningCount)}
              />
              <Metric label="Viewport events" value={String(viewportRecordCount)} />
              <Metric label="Console errors" value={String(consoleErrorCount)} />
            </div>
            <pre className="fm-diagnostic-recorder__report">
              {artifact.suspectReport.text}
            </pre>
          </TabsContent>

          <TabsContent value="startup">
            <RecordTable records={snapshot.streams.timeline} />
          </TabsContent>
          <TabsContent value="main-thread">
            <RecordTable records={snapshot.streams.performance} />
          </TabsContent>
          <TabsContent value="requests">
            <RecordTable records={snapshot.streams.requests} />
          </TabsContent>
          <TabsContent value="memory">
            <RecordTable records={snapshot.streams.memory} />
          </TabsContent>
          <TabsContent value="viewport-3d">
            <RecordTable records={snapshot.streams.viewport3d} />
          </TabsContent>
          <TabsContent value="build-engine">
            <BuildEngineSummary
              recordCount={viewportBuildRecordCount}
              summary={viewport3dBuildSummary}
            />
            <WorkerPoolSummary records={viewportWorkerPoolRecords} />
            <StaleRevisionSummary summary={viewport3dVisibleRevisionSummary} />
            <RecordTable records={snapshot.streams.viewport3dBuild} />
          </TabsContent>
          <TabsContent value="console">
            <RecordTable records={snapshot.streams.console} />
          </TabsContent>
          <TabsContent value="export">
            <pre className="fm-diagnostic-recorder__json">
              {serializeDiagnosticArtifactJson(artifact)}
            </pre>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function BuildEngineSummary({
  recordCount,
  summary,
}: {
  recordCount: number;
  summary: {
    lanes: DiagnosticViewport3DBuildLaneSummary[];
    totalJobs: number;
  };
}) {
  const worstWorkerMs = maxLaneValue(summary.lanes, "workerComputeMaxMs");
  const worstQueueMs = maxLaneValue(summary.lanes, "queueWaitMaxMs");
  const worstUploadMs = maxLaneValue(summary.lanes, "mainUploadMaxMs");
  const fallbackCount = summary.lanes.reduce(
    (total, lane) => total + lane.fallbackCount,
    0,
  );
  return (
    <section className="fm-diagnostic-recorder__section">
      <div className="fm-diagnostic-recorder__panel">
        <Metric label="Build records" value={String(recordCount)} />
        <Metric label="Build jobs" value={String(summary.totalJobs)} />
        <Metric label="Lanes" value={String(summary.lanes.length)} />
        <Metric
          label="Fallbacks"
          tone={fallbackCount > 0 ? "critical" : "default"}
          value={String(fallbackCount)}
        />
        <Metric label="Queue max" value={formatMs(worstQueueMs)} />
        <Metric label="Worker max" value={formatMs(worstWorkerMs)} />
        <Metric label="Upload max" value={formatMs(worstUploadMs)} />
      </div>
      {summary.lanes.length === 0 ? (
        <div className="fm-diagnostic-recorder__empty" role="status">
          No build-engine records.
        </div>
      ) : (
        <div className="fm-diagnostic-recorder__table">
          <table className="fm-diagnostic-recorder__native-table">
          <thead>
            <tr
            className="fm-diagnostic-recorder__row fm-diagnostic-recorder__row--header"
          >
            <th scope="col">Lane</th>
            <th scope="col">Jobs</th>
            <th scope="col">Aborted</th>
            <th scope="col">Queue</th>
            <th scope="col">Worker</th>
            <th scope="col">Transfer</th>
            <th scope="col">Upload</th>
            <th scope="col">Output</th>
            <th scope="col">Fallbacks</th>
            <th scope="col">Fallback reasons</th>
          </tr>
          </thead>
          <tbody>
          {summary.lanes.slice(0, 12).map((lane) => (
            <tr
              className="fm-diagnostic-recorder__row"
              key={lane.lane}
            >
              <td>{lane.lane}</td>
              <td>{lane.jobs}</td>
              <td>{lane.aborted}</td>
              <td>{formatMs(lane.queueWaitMaxMs)}</td>
              <td>{formatMs(lane.workerComputeMaxMs)}</td>
              <td>{formatMs(lane.transferMaxMs)}</td>
              <td>{formatMs(lane.mainUploadMaxMs)}</td>
              <td>{formatBytes(lane.outputBytes)}</td>
              <td>{lane.fallbackCount}</td>
              <td>{formatFallbackReasons(lane.fallbackReasons)}</td>
            </tr>
          ))}
          </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatFallbackReasons(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.join(", ") : "n/a";
}

function StaleRevisionSummary({
  summary,
}: {
  summary: DiagnosticViewport3DVisibleRevisionSummary;
}) {
  const staleCount =
    summary.stalePhysicalTargets.length +
    summary.staleCompatibleTargets.length +
    summary.invalidSuppressedTargets.length;
  return (
    <section className="fm-diagnostic-recorder__section">
      <div className="fm-diagnostic-recorder__panel">
        <Metric
          label="Topology"
          value={summary.topologyRevision ?? "n/a"}
        />
        <Metric label="Field" value={summary.fieldRevision ?? "n/a"} />
        <Metric
          label="Target viz"
          value={summary.targetVisualizationRevision ?? "n/a"}
        />
        <Metric label="Stale visible" value={String(staleCount)} />
      </div>
      {staleCount === 0 ? (
        <div className="fm-diagnostic-recorder__empty" role="status">
          No stale visible revisions.
        </div>
      ) : (
        <div className="fm-diagnostic-recorder__table">
          <table className="fm-diagnostic-recorder__native-table">
          <thead>
            <tr
            className="fm-diagnostic-recorder__row fm-diagnostic-recorder__row--header"
          >
            <th scope="col">State</th>
            <th scope="col">Lane</th>
            <th scope="col">Target</th>
            <th scope="col">Displayed</th>
            <th scope="col">Target revision</th>
          </tr>
          </thead>
          <tbody>
          {visibleRevisionRows(summary).map((row) => (
            <tr
              className="fm-diagnostic-recorder__row"
              key={`${row.state}:${row.target.targetKey}:${row.target.displayedRevision}:${row.target.targetRevision}`}
            >
              <td>{row.state}</td>
              <td>{row.target.lane ?? "n/a"}</td>
              <td>{row.target.targetKey ?? "n/a"}</td>
              <td>{row.target.displayedRevision ?? "n/a"}</td>
              <td>{row.target.targetRevision ?? "n/a"}</td>
            </tr>
          ))}
          </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WorkerPoolSummary({
  records,
}: {
  records: readonly DiagnosticViewport3DWorkerPoolRecord[];
}) {
  const activeJobs = records.reduce((total, record) => total + record.activeJobs, 0);
  const workerCount = records.reduce(
    (total, record) => total + record.workerCount,
    0,
  );
  const maxWorkers = records.reduce((total, record) => total + record.maxWorkers, 0);
  return (
    <section className="fm-diagnostic-recorder__section">
      <div className="fm-diagnostic-recorder__panel">
        <Metric label="Worker pools" value={String(records.length)} />
        <Metric label="Active jobs" value={String(activeJobs)} />
        <Metric label="Workers" value={String(workerCount)} />
        <Metric label="Max workers" value={String(maxWorkers)} />
      </div>
      {records.length === 0 ? (
        <div className="fm-diagnostic-recorder__empty" role="status">
          No worker-pool status.
        </div>
      ) : (
        <div className="fm-diagnostic-recorder__table">
          <table className="fm-diagnostic-recorder__native-table">
          <thead>
            <tr
            className="fm-diagnostic-recorder__row fm-diagnostic-recorder__row--header"
          >
            <th scope="col">Pool</th>
            <th scope="col">Active jobs</th>
            <th scope="col">Workers</th>
            <th scope="col">Max workers</th>
            <th scope="col">Updated</th>
          </tr>
          </thead>
          <tbody>
          {records.map((record) => {
            const updatedAt = formatDiagnosticTimestamp(record.timestampMs);
            return (
              <tr
                className="fm-diagnostic-recorder__row"
                key={record.poolId}
              >
                <td>{record.poolId}</td>
                <td>{record.activeJobs}</td>
                <td>{record.workerCount}</td>
                <td>{record.maxWorkers}</td>
                <td suppressHydrationWarning>
                  {updatedAt}
                </td>
              </tr>
            );
          })}
          </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  tone = "default",
  value,
}: {
  label: string;
  tone?: "critical" | "default";
  value: string;
}) {
  return (
    <div className="fm-diagnostic-recorder__metric" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RecordTable({ records }: { records: readonly DiagnosticAnyRecord[] }) {
  const visibleRecords = records.slice(-100).toReversed();
  if (visibleRecords.length === 0) {
    return (
      <div className="fm-diagnostic-recorder__empty" role="status">
        No records.
      </div>
    );
  }
  return (
    <div className="fm-diagnostic-recorder__table">
      <table className="fm-diagnostic-recorder__native-table">
      <thead>
        <tr
        className="fm-diagnostic-recorder__row fm-diagnostic-recorder__row--header"
      >
        <th scope="col">Time</th>
        <th scope="col">Lane</th>
        <th scope="col">Severity</th>
        <th scope="col">Name</th>
        <th scope="col">Duration</th>
      </tr>
      </thead>
      <tbody>
      {visibleRecords.map((record) => {
        const recordedAt = formatDiagnosticTimestamp(record.timestampMs);
        return (
          <tr
            className="fm-diagnostic-recorder__row"
            data-severity={record.severity}
            key={record.id || `${record.timestampMs}:${record.name}`}
          >
            <td suppressHydrationWarning>
              {recordedAt}
            </td>
            <td>{record.lane}</td>
            <td>{record.severity}</td>
            <td title={record.name}>
              {record.name}
            </td>
            <td>{formatMs(record.durationMs)}</td>
          </tr>
        );
      })}
      </tbody>
      </table>
    </div>
  );
}

function latestWorkerPoolRecords(
  records: readonly DiagnosticViewport3DWorkerPoolRecord[],
): DiagnosticViewport3DWorkerPoolRecord[] {
  const byPool = new Map<string, DiagnosticViewport3DWorkerPoolRecord>();
  for (const record of records) {
    byPool.set(record.poolId, record);
  }
  return Array.from(byPool.values()).toSorted((left, right) =>
    left.poolId.localeCompare(right.poolId),
  );
}

function maxLaneValue(
  lanes: readonly DiagnosticViewport3DBuildLaneSummary[],
  key: keyof Pick<
    DiagnosticViewport3DBuildLaneSummary,
    | "mainUploadMaxMs"
    | "queueWaitMaxMs"
    | "transferMaxMs"
    | "workerComputeMaxMs"
  >,
): number | null {
  if (lanes.length === 0) return null;
  return lanes.reduce((max, lane) => Math.max(max, lane[key]), 0);
}

function visibleRevisionRows(
  summary: DiagnosticViewport3DVisibleRevisionSummary,
): Array<{
  state: string;
  target: DiagnosticViewport3DVisibleRevisionTarget;
}> {
  return [
    ...summary.stalePhysicalTargets.map((target) => ({
      state: "stale-physical",
      target,
    })),
    ...summary.staleCompatibleTargets.map((target) => ({
      state: "stale-compatible",
      target,
    })),
    ...summary.invalidSuppressedTargets.map((target) => ({
      state: "invalid",
      target,
    })),
  ];
}

function latestMemoryBytes(
  records: readonly { usedJSHeapBytes?: number | null; trackedBytes?: number }[],
): number | null {
  const latest = records.at(-1);
  return latest?.usedJSHeapBytes ?? latest?.trackedBytes ?? null;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMs(value: number | null): string {
  return typeof value === "number" ? `${value.toFixed(1)} ms` : "n/a";
}

function formatDiagnosticTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

async function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable");
  }
  await navigator.clipboard.writeText(text);
}

function downloadTextFile({
  filename,
  mimeType,
  text,
}: {
  filename: string;
  mimeType: string;
  text: string;
}): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
