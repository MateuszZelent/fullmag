"use client";

import {
  Cpu,
  FileText,
  HardDrive,
  Server,
} from "lucide-react";

import {
  useEngineLogResource,
  useGpuTelemetryResource,
} from "@/kernel/resources/studyRuntimeResources";

export function FooterDiagnostics() {
  const engineLog = useEngineLogResource();
  const gpu = useGpuTelemetryResource();
  const latestEntries = engineLog.data?.entries.slice(-5).reverse() ?? [];
  const gpuDevices = gpu.data?.devices ?? [];
  const gpuStatus = gpu.data?.status ?? "pending";

  return (
    <div className="fm-footer-diagnostics">
      <section
        className="fm-footer-diagnostics__panel"
        aria-label="Engine log"
      >
        <div className="fm-footer-diagnostics__heading">
          <FileText size={14} aria-hidden="true" />
          <span>Engine Log</span>
          <span className="fm-footer-diagnostics__meta">
            {engineLog.data?.total ?? 0} entries
          </span>
        </div>
        {latestEntries.length > 0 ? (
          <div className="fm-footer-diagnostics__log" role="table">
            {latestEntries.map((entry, index) => (
              <div
                className="fm-footer-diagnostics__log-row"
                role="row"
                key={`${entry.timestamp_unix_ms}-${index}`}
              >
                <time role="cell">
                  {formatTime(entry.timestamp_unix_ms)}
                </time>
                <span role="cell" data-level={entry.level}>
                  {entry.level}
                </span>
                <span role="cell">{entry.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="fm-footer__empty" role="status">
            No engine log entries.
          </div>
        )}
      </section>

      <section
        className="fm-footer-diagnostics__panel"
        aria-label="GPU telemetry"
      >
        <div className="fm-footer-diagnostics__heading">
          <Cpu size={14} aria-hidden="true" />
          <span>GPU</span>
          <span className="fm-footer-diagnostics__meta">
            {titleCase(gpuStatus)}
          </span>
        </div>
        {gpuDevices.length > 0 ? (
          <div className="fm-footer-diagnostics__gpu-list">
            {gpuDevices.map((device) => (
              <div
                className="fm-footer-diagnostics__gpu"
                key={`${device.index}-${device.name}`}
              >
                <span>
                  <Server size={13} aria-hidden="true" />
                  {device.name}
                </span>
                <span>
                  <Cpu size={13} aria-hidden="true" />
                  {formatPercent(device.utilization_gpu_percent)}
                </span>
                <span>
                  <HardDrive size={13} aria-hidden="true" />
                  {formatMemory(device.memory_used_mb, device.memory_total_mb)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="fm-footer__empty" role="status">
            {gpu.data?.reason ?? "GPU telemetry pending."}
          </div>
        )}
      </section>
    </div>
  );
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function formatMemory(usedMb: number, totalMb: number) {
  return `${Math.round(usedMb)} / ${Math.round(totalMb)} MB`;
}

function titleCase(value: string) {
  if (!value) return "Unknown";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
