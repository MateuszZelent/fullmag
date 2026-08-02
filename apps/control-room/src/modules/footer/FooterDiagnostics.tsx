"use client";

import {
  AlertTriangle,
  Clipboard,
  ClipboardCheck,
  Cpu,
  FileText,
  HardDrive,
  Server,
  Timer,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { Button } from "@/shared/ui/Button";

interface SolverProfilePhaseBar {
  id: string;
  label: string;
  percent: number;
}

export interface SolverProfileRow {
  artifact: string;
  cache: string;
  clock: string;
  deepClones: string;
  demag: string;
  demagDetail: string;
  demagSetup: string;
  exchange: string;
  fieldCopy: string;
  finalization: string;
  gapPerStep: string;
  gapTotal: string;
  gpuSync: string;
  id: string;
  missing: string;
  nativeFfi: string;
  orchestration: string;
  phases: SolverProfilePhaseBar[];
  preview: string;
  relaxPreconditioner: string;
  rhs: string;
  spanSteps: string;
  spanWall: string;
  step: string;
  total: string;
}

export interface SolverProfilePanelModel {
  allRows: SolverProfileRow[];
  hasSingleThreadWarning: boolean;
  livePublisherSummary: string;
  overheadSummary: string;
  previewModeSummary: string;
  rateSummary: string;
  rows: SolverProfileRow[];
  sampleCount: number;
  state: string;
  threadSummary: string;
  windowPhaseSummary: string;
}

export interface TimestepQualificationPanelModel {
  detail: string;
  label: string;
  warning: boolean;
}

type SolverProfileCopyStatus = "copied" | "failed" | "idle";
type SolverProfileStepSampleResource =
  SolverProfileResource["latest_samples"][number];
type SolverProfilePhaseResource = SolverProfileStepSampleResource["phases"][number];

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
  const timestepQualificationModel = buildTimestepQualificationPanelModel(
    solverProfile.data,
  );
  const [profileCopyStatus, setProfileCopyStatus] =
    useState<SolverProfileCopyStatus>("idle");
  const profileCopyResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (profileCopyResetTimerRef.current !== null) {
        window.clearTimeout(profileCopyResetTimerRef.current);
      }
    };
  }, []);

  const copyProfileRows = async () => {
    try {
      await navigator.clipboard.writeText(
        serializeSolverProfileRows(profileModel.allRows),
      );
      setProfileCopyStatus("copied");
    } catch {
      setProfileCopyStatus("failed");
    }
    if (profileCopyResetTimerRef.current !== null) {
      window.clearTimeout(profileCopyResetTimerRef.current);
    }
    profileCopyResetTimerRef.current = window.setTimeout(() => {
      setProfileCopyStatus("idle");
      profileCopyResetTimerRef.current = null;
    }, 2000);
  };

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
            {profileCopyStatus === "copied" ? " | copied" : ""}
            {profileCopyStatus === "failed" ? " | copy failed" : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Copy profiler table to clipboard"
            title={`Copy ${profileModel.allRows.length} profiler rows to clipboard`}
            disabled={profileModel.allRows.length === 0}
            onClick={copyProfileRows}
          >
            {profileCopyStatus === "copied" ? (
              <ClipboardCheck size={14} aria-hidden="true" />
            ) : (
              <Clipboard size={14} aria-hidden="true" />
            )}
          </Button>
        </div>
        {timestepQualificationModel ? (
          <div
            className={
              timestepQualificationModel.warning
                ? "fm-footer-diagnostics__warning"
                : "fm-footer-diagnostics__threading"
            }
            role="status"
          >
            {timestepQualificationModel.warning ? (
              <AlertTriangle size={13} aria-hidden="true" />
            ) : (
              <Server size={13} aria-hidden="true" />
            )}
            <span>
              {timestepQualificationModel.label} — {timestepQualificationModel.detail}
            </span>
          </div>
        ) : null}
        {profileModel.rows.length > 0 ? (
          <div className="fm-footer-diagnostics__profile">
            <div className="fm-footer-diagnostics__threading">
              <Cpu size={13} aria-hidden="true" />
              <span>{profileModel.threadSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Server size={13} aria-hidden="true" />
              <span>{profileModel.livePublisherSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.previewModeSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.windowPhaseSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.rateSummary}</span>
            </div>
            <div className="fm-footer-diagnostics__threading">
              <Timer size={13} aria-hidden="true" />
              <span>{profileModel.overheadSummary}</span>
            </div>
            {profileModel.hasSingleThreadWarning ? (
              <div className="fm-footer-diagnostics__warning" role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>Effective OpenMP thread count is 1.</span>
              </div>
            ) : null}
            <div className="fm-footer-diagnostics__profile-table" role="table">
              <div className="fm-footer-diagnostics__threading">
                Last-step phases (interval aggregates are shown separately above)
              </div>
              <div
                className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header"
                role="row"
              >
                <span role="columnheader">Last step</span>
                <span role="columnheader">Clock</span>
                <span role="columnheader">Span steps</span>
                <span role="columnheader">Span wall</span>
                <span role="columnheader">Gap total</span>
                <span role="columnheader">Gap/step</span>
                <span role="columnheader">Total (last step)</span>
                <span role="columnheader">Exchange (last step)</span>
                <span role="columnheader">Demag (last step)</span>
                <span role="columnheader">Demag detail</span>
                <span role="columnheader">Setup</span>
                <span role="columnheader">Relax prec.</span>
                <span role="columnheader">RHS</span>
                <span role="columnheader">Preview</span>
                <span role="columnheader">Cache</span>
                <span role="columnheader">Field copy</span>
                <span role="columnheader">Artifact</span>
                <span role="columnheader">Finalization</span>
                <span role="columnheader">GPU sync</span>
                <span role="columnheader">Native</span>
                <span role="columnheader">Orchestr.</span>
                <span role="columnheader">Missing</span>
                <span role="columnheader">Deep clones (last step)</span>
              </div>
              {profileModel.rows.map((row) => (
                <div
                  className="fm-footer-diagnostics__profile-row"
                  role="row"
                  key={row.id}
                >
                  <span role="cell">{row.step}</span>
                  <span role="cell">{row.clock}</span>
                  <span role="cell">{row.spanSteps}</span>
                  <span role="cell">{row.spanWall}</span>
                  <span role="cell">{row.gapTotal}</span>
                  <span role="cell">{row.gapPerStep}</span>
                  <span role="cell">{row.total}</span>
                  <span role="cell">{row.exchange}</span>
                  <span role="cell">{row.demag}</span>
                  <span role="cell">{row.demagDetail}</span>
                  <span role="cell">{row.demagSetup}</span>
                  <span role="cell">{row.relaxPreconditioner}</span>
                  <span role="cell">{row.rhs}</span>
                  <span role="cell">{row.preview}</span>
                  <span role="cell">{row.cache}</span>
                  <span role="cell">{row.fieldCopy}</span>
                  <span role="cell">{row.artifact}</span>
                  <span role="cell">{row.finalization}</span>
                  <span role="cell">{row.gpuSync}</span>
                  <span role="cell">{row.nativeFfi}</span>
                  <span role="cell">{row.orchestration}</span>
                  <span role="cell">{row.missing}</span>
                  <span role="cell">{row.deepClones}</span>
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

export function serializeSolverProfileRows(
  rows: readonly SolverProfileRow[],
): string {
  const headers = [
    "Last step",
    "Clock",
    "Span steps",
    "Span wall",
    "Gap total",
    "Gap/step",
    "Total (last step)",
    "Exchange (last step)",
    "Demag (last step)",
    "Demag detail",
    "Setup",
    "Relax prec.",
    "RHS",
    "Preview",
    "Cache",
    "Field copy",
    "Artifact",
    "Finalization",
    "GPU sync",
    "Native",
    "Orchestr.",
    "Missing",
    "Deep clones (last step)",
  ];
  const body = rows.map((row) =>
    [
      row.step,
      row.clock,
      row.spanSteps,
      row.spanWall,
      row.gapTotal,
      row.gapPerStep,
      row.total,
      row.exchange,
      row.demag,
      row.demagDetail,
      row.demagSetup,
      row.relaxPreconditioner,
      row.rhs,
      row.preview,
      row.cache,
      row.fieldCopy,
      row.artifact,
      row.finalization,
      row.gpuSync,
      row.nativeFfi,
      row.orchestration,
      row.missing,
      row.deepClones,
    ].join("\t"),
  );
  return [headers.join("\t"), ...body].join("\n");
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
  const allRows = latestSamples
    .map((sample, index, samples) => ({
      sample,
      sourceIndex: latestSamples.length - samples.length + index,
    }))
    .reverse()
    .map(({ sample, sourceIndex }) => {
      const previous = sourceIndex > 0 ? latestSamples[sourceIndex - 1] : undefined;
      const hasMonotonicPredecessor =
        previous !== undefined &&
        sample.step > previous.step &&
        typeof sample.sample_time_unix_ms === "number" &&
        typeof previous.sample_time_unix_ms === "number" &&
        sample.sample_time_unix_ms > previous.sample_time_unix_ms;
      const phaseById = new Map(sample.phases.map((phase) => [phase.id, phase]));
      const demagPhaseById = new Map(
        sample.demag_subphases.map((phase) => [phase.id, phase]),
      );
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
        artifact: formatArtifactCost(
          phaseById.get("artifact_enqueue")?.wall_time_ns ?? 0,
          sample.artifact_enqueue_bytes ?? 0,
          sample.artifact_queue_depth_current ?? 0,
          sample.artifact_queue_depth_max ?? 0,
          formatCounterPairDelta(
            sample.artifact_writer_jobs_completed ?? 0,
            sample.artifact_writer_job_wall_time_ns ?? 0,
            hasMonotonicPredecessor
              ? (previous?.artifact_writer_jobs_completed ?? 0)
              : undefined,
            hasMonotonicPredecessor
              ? (previous?.artifact_writer_job_wall_time_ns ?? 0)
              : undefined,
          ),
          sample.artifact_writer_jobs_completed ?? 0,
          sample.artifact_writer_job_wall_time_ns ?? 0,
        ),
        cache: formatNs(phaseById.get("cached_preview")?.wall_time_ns ?? 0),
        clock: formatWallClockMs(sample.sample_time_unix_ms),
        deepClones: String(sample.step_update_deep_clone_count ?? 0),
        demag: formatNs(phaseById.get("demag_total")?.wall_time_ns ?? 0),
        demagDetail: formatDemagDetail(sample, demagPhaseById),
        demagSetup: formatDemagSetup(sample, phaseById),
        exchange: formatNs(phaseById.get("exchange")?.wall_time_ns ?? 0),
        fieldCopy: formatCopyCost(
          phaseById.get("field_copy")?.wall_time_ns ?? 0,
          sample.field_copy_bytes ?? 0,
        ),
        finalization: formatCopyCost(
          phaseById.get("finalization")?.wall_time_ns ?? 0,
          sample.finalization_field_copy_bytes ?? 0,
        ),
        gapPerStep: formatNs(sample.unprofiled_gap_per_step_ns ?? 0),
        gapTotal: formatNs(sample.unprofiled_gap_total_ns ?? 0),
        gpuSync: formatGpuSync(
          sample,
          hasMonotonicPredecessor ? previous : undefined,
        ),
        id: `${sample.step}:${sample.time}:${sample.sample_time_unix_ms}:${sourceIndex}`,
        missing: formatNs(sample.missing_ns),
        nativeFfi: formatNativeCost(phaseById),
        orchestration: formatNs(phaseById.get("orchestration")?.wall_time_ns ?? 0),
        phases,
        preview: formatNs(phaseById.get("preview")?.wall_time_ns ?? 0),
        relaxPreconditioner: formatNs(
          phaseById.get("relax_preconditioner")?.wall_time_ns ?? 0,
        ),
        rhs: formatNs(phaseById.get("rhs_total")?.wall_time_ns ?? 0),
        spanSteps: `${sample.span_first_step ?? sample.step}-${sample.span_last_step ?? sample.step} (${sample.span_step_count ?? 1})`,
        spanWall: formatNs(sample.span_monotonic_wall_time_ns ?? sample.total_ns),
        step: String(sample.step),
        total: formatNs(sample.total_ns),
      };
    });
  const rows = allRows.slice(0, 5);
  const threading =
    profile?.threading ??
    (rows.length > 0 ? profile?.latest_samples.at(-1)?.threading : null);

  return {
    allRows,
    hasSingleThreadWarning: threading?.effective_omp_threads === 1,
    livePublisherSummary: formatLivePublisherSummary(profile?.live_publisher),
    overheadSummary: profile?.overhead
      ? `Profiler overhead: record ${formatNs(profile.overhead.last_record_wall_time_ns)} / persist ${formatNs(profile.overhead.last_persist_wall_time_ns)} / publish ${formatNs(profile.overhead.last_publisher_replace_wall_time_ns)} / async clones seed ${profile.overhead.heartbeat_seed_deep_clone_count ?? 0}, worker ${profile.overhead.heartbeat_worker_deep_clone_count ?? 0}`
      : "Profiler overhead pending",
    previewModeSummary: formatPreviewModeSummary(profile),
    rateSummary: formatRateSummary(profile),
    rows,
    sampleCount: profile?.aggregates.sample_count ?? 0,
    state: profile?.state ?? "pending",
    threadSummary: threading ? formatThreadSummary(threading) : "Threading pending",
    windowPhaseSummary: formatWindowPhaseSummary(profile?.latest_samples.at(-1)),
  };
}

export function buildTimestepQualificationPanelModel(
  profile: SolverProfileResource | null | undefined,
): TimestepQualificationPanelModel | null {
  const qualification = profile?.timestep_qualification;
  if (!qualification) return null;

  const stateLabel = titleCase(
    qualification.validation_state.replaceAll("_", " "),
  );
  if (qualification.validation_state === "unvalidated") {
    return {
      detail: "No exact artifact/runtime-source binding.",
      label: `LLG timestep: ${stateLabel}`,
      warning: true,
    };
  }

  const bindings = [
    `Registry ${qualification.qualification_registry_version}.`,
  ];
  if (qualification.qualification_artifact_sha256) {
    bindings.push(
      `Artifact ${qualification.qualification_artifact_sha256.slice(0, 12)}.`,
    );
  }
  if (qualification.runtime_source_inputs_sha256) {
    bindings.push(
      `Runtime source ${qualification.runtime_source_inputs_sha256.slice(0, 12)}.`,
    );
  }

  return {
    detail: bindings.join(" "),
    label: `LLG timestep: ${stateLabel}`,
    warning: false,
  };
}

function formatWindowPhaseSummary(
  sample: SolverProfileStepSampleResource | null | undefined,
) {
  const phaseWindows = sample?.phase_windows ?? [];
  if (phaseWindows.length === 0) return "Window phases pending";
  const visible = phaseWindows.filter((phase) => phase.sum_wall_time_ns > 0);
  if (visible.length === 0) return "Window phases: all zero";
  return `Window phases: ${visible
    .map(
      (phase) =>
        `${phase.label} sum ${formatNs(phase.sum_wall_time_ns)} / mean ${formatNs(phase.mean_wall_time_ns)} / max ${formatNs(phase.max_wall_time_ns)}`,
    )
    .join(" | ")}`;
}

function formatPreviewModeSummary(profile: SolverProfileResource | null | undefined) {
  if (!profile) return "Preview mode pending";
  return profile.preview_3d_disabled
    ? "3D preview disabled for benchmark"
    : "3D preview enabled";
}

function formatDemagSetup(
  sample: SolverProfileStepSampleResource,
  phaseById: Map<string, SolverProfilePhaseResource>,
) {
  const setupNs = phaseById.get("demag_solver_setup")?.wall_time_ns ?? 0;
  if (sample.demag_solver_setup_reused) return "reused";
  if (setupNs > 0) return "built";
  return "n/a";
}

function formatDemagDetail(
  sample: SolverProfileStepSampleResource,
  phaseById: Map<string, SolverProfilePhaseResource>,
) {
  const parts: string[] = [];
  if (sample.demag_solver || sample.demag_preconditioner) {
    parts.push(
      `${sample.demag_solver ?? "solver?"}/${sample.demag_preconditioner ?? "prec?"}`,
    );
  }
  const solveCount = sample.demag_solves ?? 0;
  const iterations = sample.poisson_iterations ?? 0;
  const residual = sample.poisson_final_residual ?? 0;
  const applyNs = phaseById.get("demag_solver_apply")?.wall_time_ns ?? 0;
  if (solveCount > 0) parts.push(`${Math.round(solveCount)} solve`);
  if (iterations > 0) parts.push(`${Math.round(iterations)} it`);
  if (Number.isFinite(residual) && residual > 0) {
    parts.push(`res ${residual.toExponential(1)}`);
  }
  if (applyNs > 0) parts.push(`apply ${formatNs(applyNs)}`);
  return parts.length > 0 ? parts.join(" / ") : "n/a";
}

function formatThreadSummary(threading: {
  cap_reason?: string | null;
  effective_omp_threads: number;
  requested_omp_threads: number;
  thread_mode: string;
}) {
  const capReason =
    threading.cap_reason && threading.cap_reason !== "none"
      ? ` | ${threading.cap_reason}`
      : "";
  return `OMP ${threading.requested_omp_threads}->${threading.effective_omp_threads} | ${threading.thread_mode}${capReason}`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatWallClockMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "invalid";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
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

function formatCopyCost(wallTimeNs: number, bytes: number) {
  const time = formatNs(wallTimeNs);
  if (!Number.isFinite(bytes) || bytes <= 0) return time;
  return `${time} / ${formatBytes(bytes)}`;
}

function formatArtifactCost(
  wallTimeNs: number,
  bytes: number,
  queueDepthCurrent: number,
  queueDepthMax: number,
  writerDelta: CounterPairDelta,
  writerJobsCumulative: number,
  writerWallTimeCumulativeNs: number,
) {
  return [
    `enqueue now ${formatCopyCost(wallTimeNs, bytes)}`,
    `queue current ${Math.max(0, Math.round(queueDepthCurrent))} / max ${Math.max(0, Math.round(queueDepthMax))}`,
    formatWriterDelta(writerDelta),
    `writer cumulative ${Math.max(0, Math.round(writerJobsCumulative))} / ${formatNs(Math.max(0, writerWallTimeCumulativeNs))}`,
  ].join(" / ");
}

type CounterPairDelta =
  | { kind: "value"; count: number; wallTimeNs: number }
  | { kind: "reset" }
  | { kind: "unavailable" };

function formatCounterPairDelta(
  count: number,
  wallTimeNs: number,
  previousCount: number | undefined,
  previousWallTimeNs: number | undefined,
): CounterPairDelta {
  if (previousCount === undefined || previousWallTimeNs === undefined) {
    return { kind: "unavailable" };
  }
  if (count < previousCount || wallTimeNs < previousWallTimeNs) {
    return { kind: "reset" };
  }
  return {
    kind: "value",
    count: count - previousCount,
    wallTimeNs: wallTimeNs - previousWallTimeNs,
  };
}

function formatWriterDelta(delta: CounterPairDelta) {
  if (delta.kind === "unavailable") return "writer delta unavailable";
  if (delta.kind === "reset") return "writer delta reset";
  return `writer delta ${Math.round(delta.count)} / ${formatNs(delta.wallTimeNs)}`;
}

function formatNativeCost(phaseById: Map<string, SolverProfilePhaseResource>) {
  const parts: string[] = [];
  const residualNs = phaseById.get("native_ffi_overhead")?.wall_time_ns ?? 0;
  if (residualNs > 0) parts.push(formatNs(residualNs));
  const subphases = [
    ["copy", "relax_state_copy"],
    ["upload", "relax_state_upload"],
    ["ret", "relax_retraction"],
    ["grad", "relax_gradient"],
    ["metric", "relax_metric"],
    ["ls", "relax_line_search"],
    ["upd", "relax_update"],
  ] as const;
  for (const [label, phaseId] of subphases) {
    const wallTimeNs = phaseById.get(phaseId)?.wall_time_ns ?? 0;
    if (wallTimeNs > 0) parts.push(`${label} ${formatNs(wallTimeNs)}`);
  }
  return parts.length > 0 ? parts.join(" / ") : "0 ns";
}

function formatLivePublisherSummary(
  publisher: SolverProfileResource["live_publisher"] | undefined,
) {
  if (!publisher) return "Live publish: no structured samples";
  return [
    `Live publish ${Math.round(publisher.publish_count ?? 0)}`,
    `replace ${formatNs(publisher.last_replace_wall_time_ns ?? 0)}`,
    `merge ${formatNs(publisher.last_merge_wall_time_ns ?? 0)}`,
    `clone ${formatNs(publisher.last_clone_wall_time_ns ?? 0)}`,
    `sync ${formatNs(publisher.last_publish_wall_time_ns ?? 0)}`,
    `lag ${formatNs(publisher.last_publish_lag_wall_time_ns ?? 0)}`,
    `payload ${formatBytes(publisher.last_payload_estimated_bytes ?? 0)}`,
    `coalesced ${Math.round(publisher.coalesced_wake_count ?? 0)}`,
  ].join(" / ");
}

function formatGpuSync(
  sample: SolverProfileResource["latest_samples"][number],
  previous?: SolverProfileResource["latest_samples"][number],
) {
  const syncCount = sample.hot_loop_host_sync_count ?? 0;
  const previousSyncCount = previous?.hot_loop_host_sync_count;
  const deltaLabel =
    previousSyncCount === undefined
      ? "delta unavailable"
      : syncCount < previousSyncCount
        ? "delta reset"
        : `delta ${Math.round(syncCount - previousSyncCount)} sync`;
  const controlSyncCount = sample.hot_loop_control_scalar_host_sync_count ?? 0;
  const controlBytes = sample.hot_loop_control_scalar_d2h_bytes ?? 0;
  if (syncCount <= 0 && controlSyncCount <= 0 && controlBytes <= 0) {
    return `${deltaLabel} / cumulative 0 sync`;
  }
  if (controlSyncCount > 0 || controlBytes > 0) {
    return `${deltaLabel} / cumulative ${Math.round(syncCount)} sync / ctrl ${Math.round(controlSyncCount)} / ${formatBytes(controlBytes)}`;
  }
  const totalBytes = (sample.hot_loop_h2d_bytes ?? 0) + (sample.hot_loop_d2h_bytes ?? 0);
  if (totalBytes > 0) {
    return `${deltaLabel} / cumulative ${Math.round(syncCount)} sync / ${formatBytes(totalBytes)}`;
  }
  return `${deltaLabel} / cumulative ${Math.round(syncCount)} sync`;
}

function formatRateSummary(profile: SolverProfileResource | null | undefined) {
  const values = [
    ["Solver", profile?.rates?.solver_steps_per_second],
    ["End-to-end", profile?.rates?.end_to_end_steps_per_second],
    ["Published", profile?.rates?.published_steps_per_second],
  ] as const;
  const visible = values.flatMap(([label, metric]) =>
    metric
      ? [
          `${label} ${metric.value.toFixed(2)} steps/s (${metric.window_step_count} / ${(
            metric.window_wall_time_ns / 1.0e9
          ).toFixed(2)} s)`,
        ]
      : [],
  );
  return visible.length > 0 ? visible.join(" | ") : "Rates pending";
}

function formatBytes(value: number) {
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(2)} GiB`;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${Math.round(value)} B`;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.min(100, value));
}

function titleCase(value: string) {
  if (!value) return "Unknown";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
