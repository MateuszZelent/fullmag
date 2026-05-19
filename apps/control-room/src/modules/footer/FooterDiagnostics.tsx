"use client";

import {
  AlertTriangle,
  Cpu,
  FileText,
  HardDrive,
  Server,
  Timer,
} from "lucide-react";

import type {
  CpuTelemetryResource,
  SolverProfileResource,
} from "@/kernel/api/apiTypes";
import {
  useCpuTelemetryResource,
  useEngineLogResource,
  useGpuTelemetryResource,
  useSolverProfileResource,
} from "@/kernel/resources/studyRuntimeResources";

interface SolverProfilePhaseBar {
  id: string;
  label: string;
  percent: number;
}

interface SolverProfileRow {
  demag: string;
  exchange: string;
  id: string;
  missing: string;
  phases: SolverProfilePhaseBar[];
  rhs: string;
  step: string;
  total: string;
}

export interface SolverProfilePanelModel {
  hasSingleThreadWarning: boolean;
  rows: SolverProfileRow[];
  sampleCount: number;
  state: string;
  threadSummary: string;
}

interface CpuTelemetryRow {
  id: string;
  label: string;
  memory: string;
  utilization: string;
}

export interface CpuTelemetryPanelModel {
  reason: string | null;
  rows: CpuTelemetryRow[];
  status: string;
}

export function FooterDiagnostics() {
  const engineLog = useEngineLogResource();
  const cpu = useCpuTelemetryResource();
  const gpu = useGpuTelemetryResource();
  const solverProfile = useSolverProfileResource();
  const latestEntries = engineLog.data?.entries.slice(-5).reverse() ?? [];
  const cpuModel = buildCpuTelemetryPanelModel(cpu.data);
  const gpuDevices = gpu.data?.devices ?? [];
  const gpuStatus = gpu.data?.status ?? "pending";
  const profileModel = buildSolverProfilePanelModel(solverProfile.data);

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
            {latestEntries.map((entry) => (
              <div
                className="fm-footer-diagnostics__log-row"
                role="row"
                key={`${entry.timestamp_unix_ms}:${entry.level}:${entry.message}`}
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
        aria-label="FEM solver profiler"
      >
        <div className="fm-footer-diagnostics__heading">
          <Timer size={14} aria-hidden="true" />
          <span>Profiler</span>
          <span className="fm-footer-diagnostics__meta">
            {titleCase(profileModel.state)} | {profileModel.sampleCount} samples
          </span>
        </div>
        {profileModel.rows.length > 0 ? (
          <div className="fm-footer-diagnostics__profile">
            <div className="fm-footer-diagnostics__threading">
              <Cpu size={13} aria-hidden="true" />
              <span>{profileModel.threadSummary}</span>
            </div>
            {profileModel.hasSingleThreadWarning ? (
              <div className="fm-footer-diagnostics__warning" role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>Effective OpenMP thread count is 1.</span>
              </div>
            ) : null}
            <div className="fm-footer-diagnostics__profile-table" role="table">
              <div
                className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header"
                role="row"
              >
                <span role="columnheader">Step</span>
                <span role="columnheader">Total</span>
                <span role="columnheader">Exchange</span>
                <span role="columnheader">Demag</span>
                <span role="columnheader">RHS</span>
                <span role="columnheader">Missing</span>
              </div>
              {profileModel.rows.map((row) => (
                <div
                  className="fm-footer-diagnostics__profile-row"
                  role="row"
                  key={row.id}
                >
                  <span role="cell">{row.step}</span>
                  <span role="cell">{row.total}</span>
                  <span role="cell">{row.exchange}</span>
                  <span role="cell">{row.demag}</span>
                  <span role="cell">{row.rhs}</span>
                  <span role="cell">{row.missing}</span>
                </div>
              ))}
            </div>
            <div className="fm-footer-diagnostics__phase-stack" aria-hidden="true">
              {profileModel.rows[0]?.phases.map((phase, index) => (
                <span
                  className="fm-footer-diagnostics__phase"
                  data-phase-index={index % 5}
                  key={phase.id}
                  style={{ width: `${phase.percent}%` }}
                  title={`${phase.label}: ${phase.percent.toFixed(1)}%`}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="fm-footer__empty" role="status">
            Solver profiler is inactive.
          </div>
        )}
      </section>

      <section
        className="fm-footer-diagnostics__panel"
        aria-label="CPU telemetry"
      >
        <div className="fm-footer-diagnostics__heading">
          <Cpu size={14} aria-hidden="true" />
          <span>CPU</span>
          <span className="fm-footer-diagnostics__meta">
            {titleCase(cpuModel.status)}
          </span>
        </div>
        {cpuModel.rows.length > 0 ? (
          <div className="fm-footer-diagnostics__cpu-list">
            {cpuModel.rows.map((row) => (
              <div className="fm-footer-diagnostics__cpu" key={row.id}>
                <span>
                  <Server size={13} aria-hidden="true" />
                  {row.label}
                </span>
                <span>
                  <Cpu size={13} aria-hidden="true" />
                  {row.utilization}
                </span>
                <span>
                  <HardDrive size={13} aria-hidden="true" />
                  {row.memory}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="fm-footer__empty" role="status">
            {cpuModel.reason ?? "CPU telemetry pending."}
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

export function buildCpuTelemetryPanelModel(
  cpu: CpuTelemetryResource | null | undefined,
): CpuTelemetryPanelModel {
  if (!cpu) {
    return { reason: null, rows: [], status: "pending" };
  }

  if (cpu.status !== "available") {
    return {
      reason: cpu.reason ?? null,
      rows: [],
      status: cpu.status,
    };
  }

  return {
    reason: null,
    rows: [
      {
        id: "host",
        label: cpu.model_name ?? "Host CPU",
        memory: formatMemory(cpu.memory_used_mb, cpu.memory_total_mb),
        utilization: formatPercent(cpu.utilization_cpu_percent),
      },
      {
        id: "process",
        label: "Fullmag API",
        memory: `${Math.round(cpu.process_rss_mb)} MB RSS`,
        utilization: formatPercent(cpu.process_cpu_percent),
      },
      {
        id: "threads",
        label: "Threads",
        memory: `${cpu.process_threads} process`,
        utilization: `${cpu.logical_cpus} logical`,
      },
    ],
    status: cpu.status,
  };
}

export function buildSolverProfilePanelModel(
  profile: SolverProfileResource | null | undefined,
): SolverProfilePanelModel {
  const latestSamples = profile?.latest_samples ?? [];
  const visibleSamples = latestSamples
    .slice(-5)
    .map((sample, index, samples) => ({
      sample,
      sourceIndex: latestSamples.length - samples.length + index,
    }))
    .reverse();
  const rows = visibleSamples.map(({ sample, sourceIndex }) => {
    const phaseById = new Map(sample.phases.map((phase) => [phase.id, phase]));
    const phases = sample.phases.reduce<SolverProfilePhaseBar[]>((items, phase) => {
      if (phase.wall_time_ns > 0) {
        items.push({
          id: phase.id,
          label: phase.label,
          percent: clampPercent(phase.percent_of_total),
        });
      }
      return items;
    }, []);
    return {
      demag: formatNs(phaseById.get("demag_total")?.wall_time_ns ?? 0),
      exchange: formatNs(phaseById.get("exchange")?.wall_time_ns ?? 0),
      id: `${sample.step}:${sample.time}:${sourceIndex}`,
      missing: formatNs(sample.missing_ns),
      phases,
      rhs: formatNs(phaseById.get("rhs_total")?.wall_time_ns ?? 0),
      step: String(sample.step),
      total: formatNs(sample.total_ns),
    };
  });
  const threading =
    profile?.threading ??
    (rows.length > 0 ? profile?.latest_samples.at(-1)?.threading : null);

  return {
    hasSingleThreadWarning: threading?.effective_omp_threads === 1,
    rows,
    sampleCount: profile?.aggregates.sample_count ?? 0,
    state: profile?.state ?? "pending",
    threadSummary: threading
      ? `OMP ${threading.requested_omp_threads}->${threading.effective_omp_threads} | ${threading.thread_mode}`
      : "Threading pending",
  };
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

function formatNs(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} s`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} ms`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} us`;
  return `${Math.round(value)} ns`;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.min(100, value));
}

function titleCase(value: string) {
  if (!value) return "Unknown";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
