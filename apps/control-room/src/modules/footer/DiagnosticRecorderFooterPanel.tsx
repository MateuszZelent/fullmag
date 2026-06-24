"use client";

import { Download, Maximize2 } from "lucide-react";

import { serializeDiagnosticArtifactJson } from "@/kernel/performance/diagnostic-recorder/diagnosticArtifactExport";
import { useDiagnosticRecorderSnapshot } from "@/kernel/performance/diagnostic-recorder/useDiagnosticRecorderSnapshot";
import type { ModuleProps } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";

export function DiagnosticRecorderFooterPanel({
  kernel,
}: {
  kernel: ModuleProps["kernel"];
}) {
  const snapshot = useDiagnosticRecorderSnapshot(kernel.diagnosticRecorder);
  const slowest = snapshot.summary.slowestRecord;
  const memoryBytes = snapshot.streams.memory.at(-1)?.usedJSHeapBytes ?? null;
  const viewportResourceCount = snapshot.streams.viewport3d.filter(
    (record) => record.name === "viewport-3d.resource-tracked",
  ).length;
  const handleOpenClick = () => {
    kernel.bus.emit("diagnostics:recorder-open-requested", {
      source: "footer",
    });
  };
  const handleExportClick = () => {
    const artifact = kernel.diagnosticRecorder.exportArtifact();
    downloadTextFile({
      filename: diagnosticArtifactFilename(snapshot.scenario),
      mimeType: "application/json",
      text: serializeDiagnosticArtifactJson(artifact),
    });
  };

  return (
    <div className="fm-footer-recorder">
      <div className="fm-footer-recorder__metrics">
        <Metric label="Recording" value={snapshot.recording ? "on" : "off"} />
        <Metric label="Profile" value={snapshot.profile} />
        <Metric
          label="Critical"
          tone={snapshot.summary.criticalCount > 0 ? "critical" : "default"}
          value={String(snapshot.summary.criticalCount)}
        />
        <Metric
          label="Slowest"
          value={
            slowest
              ? `${slowest.name} ${formatMs(slowest.durationMs)}`
              : "n/a"
          }
        />
        <Metric label="Memory" value={formatBytes(memoryBytes)} />
        <Metric label="Viewport 3D" value={String(viewportResourceCount)} />
      </div>
      <div className="fm-footer-recorder__actions">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={handleOpenClick}
        >
          <Maximize2 size={14} aria-hidden="true" />
          Open
        </Button>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={handleExportClick}
        >
          <Download size={14} aria-hidden="true" />
          Export
        </Button>
      </div>
    </div>
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
    <div className="fm-footer-recorder__metric" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
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

function diagnosticArtifactFilename(scenario: string): string {
  return `fullmag-diagnostics-${Date.now()}-${scenario}.json`;
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
