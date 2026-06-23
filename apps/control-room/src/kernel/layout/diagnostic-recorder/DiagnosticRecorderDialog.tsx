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

export function DiagnosticRecorderDialog({
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
  const consoleErrorCount = snapshot.streams.console.filter(
    (record) => record.level === "error",
  ).length;
  const memoryBytes = latestMemoryBytes(snapshot.streams.memory);

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
    <div className="fm-diagnostic-recorder__table" role="table">
      <div
        className="fm-diagnostic-recorder__row fm-diagnostic-recorder__row--header"
        role="row"
      >
        <span role="columnheader">Time</span>
        <span role="columnheader">Lane</span>
        <span role="columnheader">Severity</span>
        <span role="columnheader">Name</span>
        <span role="columnheader">Duration</span>
      </div>
      {visibleRecords.map((record) => (
        <div
          className="fm-diagnostic-recorder__row"
          data-severity={record.severity}
          key={record.id || `${record.timestampMs}:${record.name}`}
          role="row"
        >
          <span role="cell">{new Date(record.timestampMs).toISOString()}</span>
          <span role="cell">{record.lane}</span>
          <span role="cell">{record.severity}</span>
          <span role="cell" title={record.name}>
            {record.name}
          </span>
          <span role="cell">{formatMs(record.durationMs)}</span>
        </div>
      ))}
    </div>
  );
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
