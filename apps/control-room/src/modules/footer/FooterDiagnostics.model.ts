import type { CpuTelemetryResource, SolverProfileResource } from "@/kernel/api/apiTypes";

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
  timingSemanticsTooltip: string;
  timingSummary: SolverProfileTimingSummary;
  threadSummary: string;
  windowPhaseSummary: string;
}

export interface SolverProfileTimingSummary {
  hypreGpuElapsed: string;
  hypreHostApi: string;
  rkCheckpoint: string;
  rollback: string;
}

export interface SolverTracePanelSegment {
  clockDomain: "browser" | "server";
  duration: string;
  durationNs: number;
  id: string;
  label: string;
  percent: number;
}

export interface SolverTracePanelModel {
  completeness: "complete" | "not_sampled" | "partial" | "server_only";
  completenessLabel: string;
  segments: SolverTracePanelSegment[];
  step: number | null;
  traceId: string | null;
  totalNs: number;
  unaccountedBrowser: string;
  unaccountedServer: string;
}

export interface TimestepQualificationPanelModel {
  detail: string;
  label: string;
  warning: boolean;
}

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
  const latestTimingSample = profile?.latest_samples.at(-1);

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
    timingSemanticsTooltip: formatTimingSemanticsTooltip(latestTimingSample),
    timingSummary: buildSolverProfileTimingSummary(latestTimingSample),
    threadSummary: threading ? formatThreadSummary(threading) : "Threading pending",
    windowPhaseSummary: formatWindowPhaseSummary(profile?.latest_samples.at(-1)),
  };
}

function buildSolverProfileTimingSummary(
  sample: SolverProfileStepSampleResource | null | undefined,
): SolverProfileTimingSummary {
  const timingIds = new Set(
    (sample?.timing_semantics ?? []).map((timing) => timing.id),
  );
  const hasTiming = (id: string) => timingIds.has(id);
  const timingValue = (id: string, value: number | null | undefined) =>
    hasTiming(id) ? formatNs(value ?? 0) : "Not sampled";
  const hasRkTiming =
    hasTiming("rk_transaction_capture_host_wall_time_ns") ||
    hasTiming("rk_transaction_restore_host_wall_time_ns") ||
    hasTiming("rk_transaction_capture_device_elapsed_time_ns") ||
    hasTiming("rk_transaction_restore_device_elapsed_time_ns");
  return {
    hypreGpuElapsed: timingValue(
      "demag_hypre_device_elapsed_time_ns",
      sample?.demag_hypre_device_elapsed_time_ns,
    ),
    hypreHostApi: timingValue(
      "demag_hypre_host_api_wall_time_ns",
      sample?.demag_hypre_host_api_wall_time_ns,
    ),
    rkCheckpoint: hasRkTiming
      ? [
          `capture ${timingValue(
            "rk_transaction_capture_host_wall_time_ns",
            sample?.rk_transaction_capture_host_wall_time_ns,
          )}`,
          `restore ${timingValue(
            "rk_transaction_restore_host_wall_time_ns",
            sample?.rk_transaction_restore_host_wall_time_ns,
          )}`,
          `bytes ${formatBytes(
            (sample?.rk_transaction_capture_bytes ?? 0) +
              (sample?.rk_transaction_restore_bytes ?? 0),
          )}`,
        ].join(" / ")
      : "Not sampled",
    rollback: hasRkTiming
      ? `rollback ${Math.round(sample?.rk_transaction_rollback_count ?? 0)} / commit ${Math.round(sample?.rk_transaction_commit_count ?? 0)}`
      : "Not sampled",
  };
}

const SOLVER_TRACE_SEGMENT_DEFINITIONS = [
  {
    clockDomain: "server" as const,
    id: "native_to_runner_callback_ns",
    label: "Native → runner",
  },
  {
    clockDomain: "server" as const,
    id: "runner_callback_to_publisher_enqueue_ns",
    label: "Runner → publisher",
  },
  {
    clockDomain: "server" as const,
    id: "publisher_queue_ns",
    label: "Publisher queue",
  },
  {
    clockDomain: "server" as const,
    id: "publisher_apply_ns",
    label: "Publisher apply",
  },
  {
    clockDomain: "server" as const,
    id: "api_revision_visibility_ns",
    label: "API revision",
  },
  {
    clockDomain: "browser" as const,
    id: "browser_fetch_ns",
    label: "Browser fetch",
  },
  {
    clockDomain: "browser" as const,
    id: "browser_decode_to_commit_ns",
    label: "Decode → commit",
  },
  {
    clockDomain: "browser" as const,
    id: "commit_to_animation_frame_ns",
    label: "Commit → frame",
  },
] as const;

export function buildSolverTracePanelModel(
  profile: SolverProfileResource | null | undefined,
): SolverTracePanelModel {
  const sample = profile?.latest_samples.at(-1);
  const trace = sample?.trace;
  if (!trace) {
    return {
      completeness: "not_sampled",
      completenessLabel: "Not sampled",
      segments: [],
      step: null,
      traceId: null,
      totalNs: 0,
      unaccountedBrowser: "Not sampled",
      unaccountedServer: "Not sampled",
    };
  }

  const segments = SOLVER_TRACE_SEGMENT_DEFINITIONS.flatMap((definition) => {
    const segment = trace.segments[definition.id];
    if (!segment) return [];
    const durationNs = Math.max(0, segment.duration_ns);
    return [
      {
        clockDomain: definition.clockDomain,
        duration: formatNs(durationNs),
        durationNs,
        id: definition.id,
        label: definition.label,
        percent: 0,
      },
    ];
  });
  const totalNs = segments.reduce(
    (total, segment) => total + segment.durationNs,
    0,
  );
  const normalizedSegments = segments.map((segment) => ({
    ...segment,
    percent: totalNs > 0 ? (segment.durationNs / totalNs) * 100 : 0,
  }));

  return {
    completeness: trace.completeness,
    completenessLabel: solverTraceCompletenessLabel(trace.completeness),
    segments: normalizedSegments,
    step: trace.trace_id.accepted_step,
    traceId: trace.trace_id.value,
    totalNs,
    unaccountedBrowser: formatNs(trace.unaccounted_browser_ns),
    unaccountedServer: formatNs(trace.unaccounted_server_ns),
  };
}

function solverTraceCompletenessLabel(
  completeness: SolverTracePanelModel["completeness"],
): string {
  switch (completeness) {
    case "complete":
      return "Complete (server + browser)";
    case "partial":
      return "Partial (missing segments)";
    case "server_only":
      return "Server-only (browser not observed)";
    default:
      return "Not sampled";
  }
}

function formatTimingSemanticsTooltip(
  sample: SolverProfileStepSampleResource | null | undefined,
) {
  const semantics = sample?.timing_semantics ?? [];
  if (semantics.length === 0) return "Timing semantics: Not sampled";
  return `Timing semantics: ${semantics
    .map((timing) => `${timing.id}=${timing.kind}`)
    .join("; ")}`;
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

export function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

export function formatMemory(usedMb: number, totalMb: number) {
  return `${Math.round(usedMb)} / ${Math.round(totalMb)} MB`;
}

export function formatNs(value: number) {
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

export function titleCase(value: string) {
  if (!value) return "Unknown";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
