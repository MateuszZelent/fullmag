"use client";

import {
  Clock3,
  Gauge,
  Hash,
  Magnet,
  Radio,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type {
  CurrentRunResource,
  FrequencyDomainSweepProgressResource,
  LiveStatusResource,
  ObjectMetricsResource,
  RunPerformanceResource,
  ScalarWindowResource,
  SceneResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import {
  useCurrentRunResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useObjectMetricsResource,
  useRunPerformanceResource,
  useScalarWindowResource,
  useSolverStatusResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  formatRuntimeStateLabel,
  formatRuntimeUserSolvePhaseLabel,
  isRuntimeStateActive,
  isRuntimeStateWaitingForCompute,
  resolveEffectiveRuntimeState,
  resolveRuntimeUserSolvePhase,
  type RuntimeUserSolvePhase,
} from "@/kernel/runtime/runtimeStateDisplay";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { Progress } from "@/shared/ui/Progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/Tooltip";
import { formatTorqueT } from "@/shared/domain/physics/torqueUnits";
import { hasEmptyObjectMagneticModel } from "@/shared/domain/physics/objectMagneticModel";

import {
  formatAntennaFieldEta,
  useAntennaFieldEta,
  type AntennaFieldEta,
} from "./antennaFieldEta";

import { resolveFooterPerformanceStep } from "./footerPerformanceProgress";

// UI display locale only. Scientific values and exports keep their existing
// invariant serialization and are not routed through this formatter.
const UI_NUMBER_LOCALE = "en-US";
const INTEGER_FORMAT = new Intl.NumberFormat(UI_NUMBER_LOCALE, {
  maximumFractionDigits: 0,
});
const COMPACT_DECIMAL_FORMAT = new Intl.NumberFormat(UI_NUMBER_LOCALE, {
  maximumFractionDigits: 6,
});
const TERMINAL_FOOTER_SOLVER_STATES = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "canceled",
  "error",
]);
type FooterLiveScalarSample = KernelEventMap["telemetry:scalar-sample"];

export const STAGE_PROGRESS_NOT_PUBLISHED_LABEL =
  "Stage progress not published by this runtime";

type FooterScalarResourceSample = {
  revision: number;
  row: Record<string, number>;
  runId: string;
  sessionId: string;
};

type FooterRelaxationAlgorithm = NonNullable<
  LiveStatusResource["solver"]["relaxation_algorithm"]
>;

const FOOTER_RELAXATION_ALGORITHMS = new Set<FooterRelaxationAlgorithm>([
  "llg_overdamped",
  "projected_gradient_bb",
  "nonlinear_cg",
  "tangent_plane_implicit",
]);

const FOOTER_SCALAR_COLUMNS = ["step", "time", "mx", "my", "mz", "e_total"] as const;

export function FooterTelemetry({
  bus,
  status,
  stageExecution,
  statusHost = null,
  view,
}: {
  bus: EventBus<KernelEventMap>;
  status: FooterTelemetryStatus | null;
  stageExecution: Pick<ResourceResult<StageExecutionResource | null>, "data" | "status">;
  /** Dock header slot for the run status; falls back to an in-panel strip. */
  statusHost?: HTMLElement | null;
  view: "overview" | "antenna";
}) {
  const solverStatus = useSolverStatusResource({ enabled: Boolean(status) && view === "overview" });
  const solverStatusForRun = resolveFooterSolverStatus(status, solverStatus.data);
  const antennaStage = resolveFooterAntennaStage(status, stageExecution.data);
  const antennaNumerical = antennaStage ? readAntennaProgress(antennaStage.record) : null;
  const antennaNowMs = useAntennaStageClock(
    view === "antenna" && !antennaNumerical ? antennaStage?.clockKey ?? null : null,
  );
  const antennaEta = useAntennaFieldEta(
    view === "antenna" && antennaStage?.active && antennaNumerical?.phase === "evaluating_field"
      ? {
          identity: antennaStage.identityKey,
          completed: antennaNumerical.completed_targets,
          total: antennaNumerical.total_targets,
          elapsedSeconds: antennaNumerical.elapsed_seconds,
        } : null,
  );
  const generalTelemetryEnabled = Boolean(status) && view === "overview" && !antennaStage;
  const performance = useRunPerformanceResource({
    enabled: generalTelemetryEnabled && Boolean(status?.run?.run_id),
  });
  const liveSample = useFooterLiveScalarSample(bus);
  const scalarWindow = useScalarWindowResource({
    columns: FOOTER_SCALAR_COLUMNS,
    enabled: generalTelemetryEnabled,
    limit: 1,
    tail: true,
  });
  const scene = useSceneResource();
  const selectedObjectId = useSelectionSelector(
    (selection) => selection.objectId,
  );
  const objectId = useMemo(
    () => resolvePrimaryTelemetryObjectId(scene.data, selectedObjectId),
    [scene.data, selectedObjectId],
  );
  const objectMetrics = useObjectMetricsResource(generalTelemetryEnabled ? objectId : null);
  // Frequency-response artifacts exist only for studies with such a stage;
  // polling them elsewhere only produces 404s.
  const loadsFrequencyResponse =
    generalTelemetryEnabled &&
    studyHasFrequencyResponseStage(solverStatusForRun?.stage_kind, stageExecution.data);
  const responseProgress = useFrequencyDomainResponseProgressResource({
    enabled: loadsFrequencyResponse,
  });
  const responseSweep = useFrequencyDomainResponseSweepResource({
    enabled: loadsFrequencyResponse,
  });
  const currentRun = useCurrentRunResource({ enabled: generalTelemetryEnabled });
  const currentRunForStatus = resolveFooterCurrentRun(status, currentRun.data);
  const userSolvePhase = status
    ? resolveRuntimeUserSolvePhase({
        detailedRuntimeState: solverStatusForRun?.runtime_state,
        runStatus: currentRunForStatus?.status,
        runStatusReason: currentRunForStatus?.status_reason,
        sessionSolverState: status.solver.state,
      })
    : null;
  // 204/null from `/simulation/stages/execution` means this runtime does not
  // publish stage execution; it is not an error and not a missing identity.
  const stageExecutionUnpublished =
    stageExecution.data === null &&
    (stageExecution.status === "ready" || stageExecution.status === "idle");
  const telemetry = buildFooterTelemetryModel(
    status,
    objectId && objectMetrics.data?.object_id === objectId ? objectMetrics.data : null,
    solverStatusForRun,
    liveSample,
    stageExecution.data,
    responseProgress.data,
    responseSweep.data,
    scalarWindow.data,
    {
      magneticModelPresent: resolveFooterMagneticModelPresent(scene),
      performance: performance.data,
      performanceStatus: performance.status,
      performanceRefreshFailed: Boolean(performance.error || performance.refreshError),
      currentRunStatus: currentRunForStatus?.status,
      nowMs: antennaNowMs,
      stageExecutionUnpublished,
      userSolvePhase,
    },
  );
  const stageProgress = resolveFooterStageProgress(stageExecution.data);
  const history = useTelemetryHistory(
    status?.run?.run_id ?? null,
    telemetry.metrics.find((metric) => metric.id === "time")?.numeric ?? null,
    telemetry.metrics.find((metric) => metric.id === "energy-total")?.numeric ?? null,
    telemetry.metrics.find((metric) => metric.id === "max-torque")?.numeric ?? null,
  );
  // One card per group in a fixed order, as on the mockup telemetry board.
  const metricGroups = FOOTER_TELEMETRY_GROUP_ORDER.flatMap((id) => {
    const metrics = telemetry.metrics.filter((metric) => metricGroup(metric.id) === id);
    return metrics.length > 0 ? [{ id, metrics }] : [];
  });

  if (view === "antenna" && !antennaStage) {
    return (
      <div className="fm-footer-telemetry__empty" role="region" aria-label="Antenna telemetry">
        <strong>No antenna stage in the current execution</strong>
        <span>Antenna progress requires an explicitly authored stage matching the current session and run.</span>
      </div>
    );
  }
  if (view === "overview" && antennaStage) {
    return (
      <div className="fm-footer-telemetry__empty" role="region" aria-label="Simulation telemetry">
        <strong>{telemetry.statusTitle}</strong>
        <span>Open the Antenna tab for field samples, phase and result publication.</span>
      </div>
    );
  }

  const statusSummary = (
    <TelemetryStatusSummary
      detail={telemetry.statusDetail}
      online={telemetry.onlineTitle}
      onlineDetail={telemetry.onlineDetail}
      state={telemetry.statusState}
      title={telemetry.statusTitle}
    />
  );
  const progressStrip = telemetry.antennaProgress ? (
    <AntennaFieldProgressStrip progress={telemetry.antennaProgress} eta={antennaEta} />
  ) : telemetry.frequencyDomainProgress ? (
    <FrequencyDomainProgressStrip progress={telemetry.frequencyDomainProgress} />
  ) : telemetry.stageProgressNotice ? (
    <span
      className="fm-footer-telemetry__notice"
      data-state="unpublished"
      title="The runtime returned no stage execution projection (HTTP 204). Run status remains authoritative."
    >
      {telemetry.stageProgressNotice}
    </span>
  ) : null;

  return (
    <div className="fm-footer-telemetry" role="region" aria-label={view === "antenna" ? "Antenna telemetry" : "Simulation telemetry"}>
      {statusHost ? createPortal(statusSummary, statusHost) : null}
      {!statusHost || progressStrip ? (
        <div className="fm-footer-telemetry__strip">
          {statusHost ? null : statusSummary}
          {progressStrip}
        </div>
      ) : null}

      <TooltipProvider delayDuration={250} skipDelayDuration={120}>
        <div className="fm-footer-telemetry__metrics">
          <div role="group" className="fm-footer-telemetry__metrics-grid" aria-label="Simulation metrics">
            {metricGroups.map(({ id, metrics }) => (
              <TelemetryBoardGroup
                history={history}
                id={id}
                key={id}
                metrics={metrics}
                stage={id === "runtime" ? stageProgress : null}
              />
            ))}
          </div>
        </div>
      </TooltipProvider>
    </div>
  );
}

/** Status reads as plain words; the "System Status:" prefix only repeats the context. */
function compactStatusTitle(title: string): string {
  return title.replace(/^System Status:\s*/i, "");
}

function TelemetryStatusSummary({
  detail,
  online,
  onlineDetail,
  state,
  title,
}: {
  detail: string;
  online: string;
  onlineDetail: string;
  state: string;
  title: string;
}) {
  const label = compactStatusTitle(title);
  return (
    <span
      className="fm-footer-telemetry__status"
      data-state={state}
      role="status"
      title={`${label}: ${detail}\n${online}: ${onlineDetail}`}
    >
      <span className="fm-footer-telemetry__strip-dot" data-state={state} aria-hidden="true" />
      <span className="fm-footer-telemetry__status-title">{label}</span>
      <span className="fm-footer-telemetry__status-online">{online}</span>
    </span>
  );
}

function useFooterLiveScalarSample(
  bus: EventBus<KernelEventMap>,
): FooterLiveScalarSample | null {
  const [sample, setSample] = useState<FooterLiveScalarSample | null>(null);

  useEffect(
    () => bus.subscribe("telemetry:scalar-sample", (next) => setSample(next)),
    [bus],
  );

  return sample;
}

type FooterTelemetryMetric = {
  detail: string;
  icon: ReactNode;
  id: string;
  label: string;
  subdetail: string;
  unit?: string;
  value: string;
  /** Finite reading behind `value`, for bars and history sparklines. */
  numeric?: number | null;
};

export type FooterTelemetryStatus = {
  energies: Pick<
    LiveStatusResource["energies"],
    "anisotropy" | "demag" | "dmi" | "exchange" | "total" | "zeeman"
  > | null;
  metrics: Pick<
    LiveStatusResource["metrics"],
    "steps_per_second" | "total_steps"
  >;
  run: Pick<
    NonNullable<LiveStatusResource["run"]>,
    | "calibration_id"
    | "requested_device"
    | "resolved_device"
    | "run_id"
    | "selection_confidence"
    | "selection_reason"
    | "solver_steps"
    | "solver_time"
  > | null;
  sessionId: string;
  sessionEpoch: string;
  requestScopeEpoch: string;
  scalarsRevision: number;
  solver: Pick<
    LiveStatusResource["solver"],
    | "algorithm"
    | "converged"
    | "dt"
    | "max_torque_T"
    | "relaxation_algorithm"
    | "state"
  >;
};

export function selectFooterTelemetryStatus(
  sessionStatus: ResourceResult<LiveStatusResource>,
): FooterTelemetryStatus | null {
  const data = sessionStatus.data;
  if (!data) return null;

  return {
    energies: data.energies
      ? {
          anisotropy: data.energies.anisotropy ?? null,
          demag: data.energies.demag ?? null,
          dmi: data.energies.dmi ?? null,
          exchange: data.energies.exchange ?? null,
          total: data.energies.total ?? null,
          zeeman: data.energies.zeeman ?? null,
        }
      : null,
    metrics: {
      steps_per_second: data.metrics.steps_per_second ?? null,
      total_steps: data.metrics.total_steps,
    },
    run: data.run
      ? {
          calibration_id: data.run.calibration_id ?? null,
          requested_device: data.run.requested_device,
          resolved_device: data.run.resolved_device,
          run_id: data.run.run_id,
          selection_confidence: data.run.selection_confidence ?? null,
          selection_reason: data.run.selection_reason,
          solver_steps: data.run.solver_steps,
          solver_time: data.run.solver_time,
        }
      : null,
    sessionId: data.session.session_id,
    sessionEpoch: data.session.session_epoch,
    requestScopeEpoch: data.session.request_scope_epoch,
    scalarsRevision: data.resources.scalars_revision,
    solver: {
      algorithm: data.solver.algorithm ?? null,
      converged: data.solver.converged ?? null,
      dt: data.solver.dt ?? null,
      max_torque_T: data.solver.max_torque_T ?? null,
      relaxation_algorithm: data.solver.relaxation_algorithm ?? null,
      state: data.solver.state,
    },
  };
}

export function footerTelemetryStatusEquals(
  previous: FooterTelemetryStatus | null,
  next: FooterTelemetryStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;

  return (
    Object.is(previous.metrics.steps_per_second, next.metrics.steps_per_second) &&
    Object.is(previous.metrics.total_steps, next.metrics.total_steps) &&
    Object.is(previous.sessionId, next.sessionId) &&
    Object.is(previous.sessionEpoch, next.sessionEpoch) &&
    Object.is(previous.requestScopeEpoch, next.requestScopeEpoch) &&
    Object.is(previous.scalarsRevision, next.scalarsRevision) &&
    Object.is(previous.run?.run_id ?? null, next.run?.run_id ?? null) &&
    Object.is(
      previous.run?.requested_device ?? null,
      next.run?.requested_device ?? null,
    ) &&
    Object.is(
      previous.run?.resolved_device ?? null,
      next.run?.resolved_device ?? null,
    ) &&
    Object.is(
      previous.run?.selection_reason ?? null,
      next.run?.selection_reason ?? null,
    ) &&
    Object.is(
      previous.run?.calibration_id ?? null,
      next.run?.calibration_id ?? null,
    ) &&
    Object.is(
      previous.run?.selection_confidence ?? null,
      next.run?.selection_confidence ?? null,
    ) &&
    Object.is(
      previous.run?.solver_steps ?? null,
      next.run?.solver_steps ?? null,
    ) &&
    Object.is(
      previous.run?.solver_time ?? null,
      next.run?.solver_time ?? null,
    ) &&
    Object.is(previous.solver.algorithm, next.solver.algorithm) &&
    Object.is(previous.solver.relaxation_algorithm, next.solver.relaxation_algorithm) &&
    Object.is(previous.solver.converged, next.solver.converged) &&
    Object.is(previous.solver.dt, next.solver.dt) &&
    Object.is(previous.solver.max_torque_T, next.solver.max_torque_T) &&
    Object.is(previous.solver.state, next.solver.state) &&
    Object.is(
      previous.energies?.anisotropy ?? null,
      next.energies?.anisotropy ?? null,
    ) &&
    Object.is(
      previous.energies?.demag ?? null,
      next.energies?.demag ?? null,
    ) &&
    Object.is(previous.energies?.dmi ?? null, next.energies?.dmi ?? null) &&
    Object.is(
      previous.energies?.exchange ?? null,
      next.energies?.exchange ?? null,
    ) &&
    Object.is(
      previous.energies?.total ?? null,
      next.energies?.total ?? null,
    ) &&
    Object.is(
      previous.energies?.zeeman ?? null,
      next.energies?.zeeman ?? null,
    )
  );
}

export function buildFooterTelemetryModel(
  status: FooterTelemetryStatus | null | undefined,
  objectMetrics: ObjectMetricsResource | null | undefined,
  solverStatus?: SolverStatusResource | null,
  liveSample?: FooterLiveScalarSample | null,
  stageExecution?: StageExecutionResource | null,
  responseProgress?: FrequencyDomainSweepProgressResource | null,
  responseSweep?: unknown,
  scalarWindow?: ScalarWindowResource | null,
  runtimePhase?: {
    magneticModelPresent?: boolean | null;
    performance?: RunPerformanceResource | null;
    performanceStatus?: ResourceResult<RunPerformanceResource>["status"];
    performanceRefreshFailed?: boolean;
    currentRunStatus?: string | null;
    nowMs?: number | null;
    stageExecutionUnpublished?: boolean;
    userSolvePhase?: RuntimeUserSolvePhase | null;
  },
) {
  if (!status) return {
    awaitingCompute: false,
    antennaProgress: null,
    frequencyDomainProgress: null,
    stageProgressNotice: null,
    metrics: [] as FooterTelemetryMetric[],
    onlineDetail: "No current session telemetry",
    onlineTitle: "Local / Standby",
    statusDetail: "Waiting for current session telemetry",
    statusState: "unknown",
    statusTitle: "System Status: No live telemetry",
  };

  const antennaStage = resolveFooterAntennaStage(status, stageExecution);
  if (antennaStage) return buildAntennaSolveTelemetry(antennaStage, runtimePhase?.nowMs ?? null);

  const completedRun =
    isTerminalFooterSolverState(status.solver.state) ||
    isTerminalFooterSolverState(runtimePhase?.currentRunStatus);
  const liveSampleForStatus = resolveLiveSampleForStatus(status, liveSample, completedRun);
  const resourceSample = resolveFooterScalarResourceSample(status, scalarWindow);
  const scalarSample = !resourceSample ||
      (completedRun && resourceSample.row.step !== status.run?.solver_steps) ||
      (liveSampleForStatus && typeof liveSampleForStatus.revision === "number" &&
        resourceSample.revision <= liveSampleForStatus.revision)
    ? liveSampleForStatus
    : resourceSample;
  const liveRow = scalarSample?.row ?? null;
  const runSolverStatus = resolveFooterSolverStatus(status, solverStatus);
  const runtimeState =
    resolveEffectiveRuntimeState({
      detailedRuntimeState: runSolverStatus?.runtime_state,
      sessionSolverState: status?.solver?.state,
    }) ?? "unknown";
  const runtimeStateLabel = formatRuntimeStateLabel(runtimeState);
  const activeStageMethod = resolveFooterActiveStageMethod(status, stageExecution);
  const runtimeRelaxationAlgorithm = resolveFooterRuntimeRelaxationAlgorithm(
    status,
    runSolverStatus,
    stageExecution,
  );
  const runtimeSolverDescription = describeFooterSolverAlgorithm(
    runtimeRelaxationAlgorithm,
    runSolverStatus?.integrator,
    activeStageMethod,
  );
  const activeSolverExecution = Boolean(status.run?.run_id) &&
    (isRuntimeStateActive(runtimeState) || activeStageMethod !== null);
  const simTimeSeconds =
    (completedRun
      ? status?.run?.solver_time ??
        runSolverStatus?.sim_time_seconds ??
        scalarSampleNumber(liveRow, "time")
      : scalarSampleNumber(liveRow, "time") ??
        runSolverStatus?.sim_time_seconds ??
        status?.run?.solver_time) ?? null;
  const currentStageIsLlg = isFooterLlgRuntimeStageMethod(activeStageMethod);
  const pseudoTimeSeconds = currentStageIsLlg
    ? null
    : scalarSampleNumber(liveRow, "pseudo_time_s") ??
      runSolverStatus?.pseudo_time_seconds ??
      null;
  const activeRuntimeSeconds =
    scalarSampleNumber(liveRow, "active_runtime_s") ??
    objectNumber(runSolverStatus, "active_runtime_seconds") ??
    null;
  const usesPseudoTime = pseudoTimeSeconds !== null;
  const directMinimizerWithoutPseudoTime =
    runtimeRelaxationAlgorithm !== null &&
    runtimeRelaxationAlgorithm !== "llg_overdamped" &&
    !usesPseudoTime;
  const primaryTimeSeconds = usesPseudoTime
    ? pseudoTimeSeconds
    : directMinimizerWithoutPseudoTime
      ? null
      : simTimeSeconds;
  const totalSteps =
    (completedRun
      ? status?.run?.solver_steps ??
        runSolverStatus?.step_index ??
        status?.metrics?.total_steps
      : scalarSampleNumber(liveRow, "step") ??
        runSolverStatus?.step_index ??
        status?.run?.solver_steps ??
        status?.metrics?.total_steps) ?? null;
  const observedSolverStep = resolveFooterPerformanceStep(
    status.run?.run_id, runtimePhase?.performance,
  );
  const stepsPerSecond = status?.metrics?.steps_per_second;
  const maxTorqueT =
    scalarSampleNumber(liveRow, "max_torque_T") ??
    runSolverStatus?.max_torque_T ??
    status?.solver?.max_torque_T;
  const dt =
    scalarSampleNumber(liveRow, "solver_dt") ??
    scalarSampleNumber(liveRow, "dt") ??
    runSolverStatus?.dt_seconds ??
    status?.solver?.dt;
  const errorEstimate =
    scalarSampleNumber(liveRow, "error_estimate") ?? runSolverStatus?.error_estimate ?? null;
  const maxError = scalarSampleNumber(liveRow, "max_error") ?? runSolverStatus?.max_error ?? null;
  const dtSuggested =
    scalarSampleNumber(liveRow, "dt_suggested") ?? runSolverStatus?.dt_suggested_seconds ?? null;
  const rejectedAttempts =
    scalarSampleNumber(liveRow, "rejected_attempts") ?? runSolverStatus?.rejected_attempts ?? null;
  const rejectedAttemptsLabel = rejectedAttempts === null
    ? "Rejected attempts unavailable"
    : `${formatInteger(rejectedAttempts)} rejected`;
  const converged = runSolverStatus?.converged ?? status?.solver?.converged;
  const scalarEnergy = {
    anisotropy: scalarSampleNumber(liveRow, "e_ani"),
    demag: scalarSampleNumber(liveRow, "e_demag"),
    dmi: scalarSampleNumber(liveRow, "e_dmi"),
    exchange: scalarSampleNumber(liveRow, "e_ex"),
    total: scalarSampleNumber(liveRow, "e_total"),
    zeeman: scalarSampleNumber(liveRow, "e_ext"),
  };
  const scalarMagnetization = scalarSampleMagnetization(liveRow);
  // The footer's magnetization is the same global table observable as Analysis.
  // A selected object's metric is intentionally not a fallback: object scope
  // must never silently replace the global ferromagnetic average.
  const magnetization = scalarMagnetization;
  const magnetizationMagnitude = magnetization
    ? Math.hypot(magnetization.mx, magnetization.my, magnetization.mz)
    : null;
  const userSolvePhase = runtimePhase?.userSolvePhase ?? null;
  const statusTitle = userSolvePhase
    ? `System Status: ${formatRuntimeUserSolvePhaseLabel(userSolvePhase)}`
    : `System Status: ${runtimeStateLabel}`;
  const active = isRuntimeStateActive(runtimeState);
  const waitingForCompute =
    userSolvePhase === "awaiting_user_solve" ||
    isRuntimeStateWaitingForCompute(runtimeState);
  const liveSampleSource = scalarSample
    ? scalarSample === liveSampleForStatus ? "Live scalar sample" : "Accepted scalar observation"
    : null;
  const magnetizationSource = liveSampleSource ?? "No global sample";
  const objectEnergySource = objectMetrics?.has_solver_sample === true
    ? objectMetrics.source === "solver_per_object" ? `Object: ${objectMetrics.object_id}`
      : objectMetrics.source === "solver_energy_only" || objectMetrics.source === "solver_spatial_object"
        ? "Session summary (object resource)" : null
    : null;
  const energyMetric = (key: keyof typeof scalarEnergy, detail: string, label: string): FooterTelemetryMetric => {
    const candidates = completedRun
      ? [[status?.energies?.[key], "Session summary"]] as const
      : [
          [scalarEnergy[key], liveSampleSource],
          [objectEnergySource ? objectMetrics?.energies?.[key] : null, objectEnergySource],
          [status?.energies?.[key], "Session summary"],
        ] as const;
    const sample = candidates.find(([value]) => typeof value === "number" && Number.isFinite(value));
    return {
      detail, icon: <Zap size={14} aria-hidden="true" />, id: `energy-${key}`, label,
      subdetail: sample?.[1] ?? "No energy sample", unit: "J",
      value: formatScientific(sample?.[0], "—"),
      numeric: finiteOrNull(sample?.[0]),
    };
  };
  const timeSource = completedRun
    ? "Current run status"
    : liveRow
      ? `Scalar revision ${String(scalarSample?.revision ?? "unavailable")}`
      : runSolverStatus
        ? "Source: solver status"
        : status
          ? "Source: session status"
          : "Source unavailable";
  const solverMetric: FooterTelemetryMetric = {
    detail: activeSolverExecution
      ? runtimeSolverDescription?.detail ?? "Runtime solver provenance unavailable"
      : "No active solver execution",
    icon: <Gauge size={14} aria-hidden="true" />,
    id: "active-solver",
    label: "Solver",
    subdetail: activeSolverExecution
      ? `Runtime state: ${runtimeStateLabel}`
      : `State: ${runtimeStateLabel}`,
    value: activeSolverExecution
      ? runtimeSolverDescription?.value ?? "Unknown"
      : "—",
  };
  const frequencyDomainProgress = buildFrequencyDomainProgress({
    responseProgress,
    responseSweep,
    solverStageKind: runSolverStatus?.stage_kind,
    stageExecution,
  });

  const stageProgressNotice =
    !frequencyDomainProgress &&
    runtimePhase?.stageExecutionUnpublished === true &&
    (active || runtimeState === "paused")
      ? STAGE_PROGRESS_NOT_PUBLISHED_LABEL
      : null;

  return {
    awaitingCompute: userSolvePhase === "awaiting_user_solve",
    frequencyDomainProgress,
    antennaProgress: null,
    stageProgressNotice,
    metrics: ([
      {
        detail: usesPseudoTime
          ? "Direct minimizer pseudotime"
          : directMinimizerWithoutPseudoTime
            ? `${runtimeSolverDescription?.detail ?? "Direct minimizer"} does not integrate physical time`
            : "Physical simulation time",
        icon: <Clock3 size={14} aria-hidden="true" />,
        id: "time",
        label: usesPseudoTime ? "Pseudo time" : "Sim time",
        subdetail: directMinimizerWithoutPseudoTime
          ? "Not applicable: the runtime did not publish pseudotime"
          : timeSource,
        unit: directMinimizerWithoutPseudoTime ? undefined : "s",
        value: formatScientific(primaryTimeSeconds, "—"),
        numeric: finiteOrNull(primaryTimeSeconds),
      },
      ...(usesPseudoTime
        ? [
            {
              detail: "Physical simulation time",
              icon: <Clock3 size={14} aria-hidden="true" />,
              id: "sim-time",
              label: "Sim time",
              subdetail: timeSource,
              unit: "s",
              value: formatScientific(simTimeSeconds, "—"),
              numeric: finiteOrNull(simTimeSeconds),
            },
          ]
        : []),
      ...(activeRuntimeSeconds !== null
        ? [
            {
              detail: "Active compute time",
              icon: <Clock3 size={14} aria-hidden="true" />,
              id: "active-runtime",
              label: "Runtime",
              subdetail: timeSource,
              value: formatDuration(activeRuntimeSeconds),
            },
          ]
        : []),
      {
        detail: "Closed profiler span",
        icon: <Radio size={14} aria-hidden="true" />,
        id: "rate",
        label: "End-to-end rate",
        subdetail: `${formatInteger(totalSteps)} steps`,
        unit: "steps/s",
        value: formatFixed(stepsPerSecond, 1, "—"),
      },

      ...(observedSolverStep !== null ? [{
        detail: "Last backend-reported solver step for the recorded stage. Field and scalar sample clocks are independent.",
        icon: <Hash size={14} aria-hidden="true" />,
        id: "solver-progress",
        label: "Solver step",
        subdetail: `Stage ${runtimePhase?.performance?.step_id ?? "unknown"} · ${
          runtimePhase?.performanceRefreshFailed
            ? "last observed; refresh unavailable"
            : runtimePhase?.performanceStatus && runtimePhase.performanceStatus !== "ready"
              ? "last observed; updating"
              : "observed"
        }`,
        value: formatInteger(observedSolverStep),
        unit: "steps",
      }] : []),
      {
        detail: observedSolverStep !== null ? "Step of the displayed telemetry sample" : "Latest step",
        icon: <Hash size={14} aria-hidden="true" />,
        id: "step",
        label: observedSolverStep !== null ? "Sample step" : "Step",
        subdetail: directMinimizerWithoutPseudoTime
          ? "Physical time not applicable"
          : `t=${formatScientific(
              completedRun || liveRow
                ? simTimeSeconds
                : objectMetrics?.time_seconds ?? simTimeSeconds,
              "—",
            )} s`,
        value: formatInteger(
          completedRun || liveRow ? totalSteps : objectMetrics?.step ?? totalSteps,
        ),
        unit: "steps",
      },
      {
        detail: usesPseudoTime
          ? "Minimizer pseudotime step"
          : directMinimizerWithoutPseudoTime
            ? `${runtimeSolverDescription?.value ?? "Direct minimizer"} does not publish a physical timestep`
            : "Solver timestep",
        icon: <Clock3 size={14} aria-hidden="true" />,
        id: "dt",
        label: usesPseudoTime ? "Pseudo dt" : "dt",
        subdetail: directMinimizerWithoutPseudoTime
          ? "Not applicable: no physical timestep is used"
          : `State: ${runtimeStateLabel}`,
        unit: directMinimizerWithoutPseudoTime ? undefined : "s",
        value: formatScientific(directMinimizerWithoutPseudoTime ? null : dt, "—"),
      },
      solverMetric,
      ...(!usesPseudoTime && !directMinimizerWithoutPseudoTime &&
      (errorEstimate !== null || maxError !== null)
        ? [
            {
              detail: "Latest embedded vector error",
              icon: <Gauge size={14} aria-hidden="true" />,
              id: "solver-error",
              label: "Error",
              subdetail: `${rejectedAttemptsLabel}; next dt ${formatScientific(dtSuggested, "—")} s`,
              value: formatScientific(errorEstimate, "—"),
            },
            {
              detail: "Adaptive acceptance threshold",
              icon: <Gauge size={14} aria-hidden="true" />,
              id: "solver-max-error",
              label: "MaxError",
              subdetail: errorEstimate !== null && maxError !== null
                ? errorEstimate <= maxError ? "Within tolerance" : "Above tolerance"
                : "Tolerance status unavailable",
              value: formatScientific(maxError, "—"),
            },
          ]
        : []),
      {
        detail: "Peak Load",
        icon: <Gauge size={14} aria-hidden="true" />,
        id: "max-torque",
        label: "Max Torque",
        subdetail: `Converged: ${formatBoolean(converged)}`,
        value: formatTorqueTelemetry(maxTorqueT),
        numeric: finiteOrNull(maxTorqueT),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={14} aria-hidden="true" />,
        id: "avg-mx",
        label: "avg mx",
        subdetail: magnetizationSource,
        value: formatFixed(magnetization?.mx, 6, "—"),
        numeric: finiteOrNull(magnetization?.mx),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={14} aria-hidden="true" />,
        id: "avg-my",
        label: "avg my",
        subdetail: magnetizationSource,
        value: formatFixed(magnetization?.my, 6, "—"),
        numeric: finiteOrNull(magnetization?.my),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={14} aria-hidden="true" />,
        id: "avg-mz",
        label: "avg mz",
        subdetail: magnetizationSource,
        value: formatFixed(magnetization?.mz, 6, "—"),
        numeric: finiteOrNull(magnetization?.mz),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={14} aria-hidden="true" />,
        id: "avg-m",
        label: "|avg m|",
        subdetail: magnetizationSource,
        value: formatFixed(magnetizationMagnitude, 6, "—"),
      },
      energyMetric("total", "Total", "Energy"),
      energyMetric("exchange", "Exchange", "Exchange"),
      energyMetric("demag", "Demag", "Demag"),
      energyMetric("zeeman", "Zeeman", "Zeeman"),
      energyMetric("anisotropy", "Anisotropy", "Anisotropy"),
      energyMetric("dmi", "DMI", "DMI"),
    ] satisfies FooterTelemetryMetric[]).filter((metric) =>
      runtimePhase?.magneticModelPresent !== false ||
      (metric.id !== "max-torque" && metricGroup(metric.id) !== "magnetization" &&
        metricGroup(metric.id) !== "energy"),
    ),
    onlineDetail: status ? "Session state" : "Awaiting session",
    onlineTitle: userSolvePhase === "preparing_model"
      ? "Session / Preparing"
      : waitingForCompute
      ? "Session / Waiting"
      : active
        ? "Session / Active"
        : status
          ? "Session / Standby"
          : "Awaiting session",
    statusDetail: status ? "Runtime telemetry" : "Waiting for runtime",
    statusState: runtimeState,
    statusTitle,
  };
}

type FooterAntennaStage = {
  active: boolean;
  identityKey: string;
  clockKey: string | null;
  record: StageExecutionResource["stages"][number];
};

export function resolveFooterAntennaStage(
  status: FooterTelemetryStatus | null | undefined,
  execution: StageExecutionResource | null | undefined,
): FooterAntennaStage | null {
  if (!status?.sessionId || !status.sessionEpoch || !status.requestScopeEpoch ||
    !status.run?.run_id || !execution ||
    execution.session_id !== status.sessionId ||
    execution.session_epoch !== status.sessionEpoch ||
    execution.request_scope_epoch !== status.requestScopeEpoch ||
    execution.run_id !== status.run.run_id) return null;

  // Accepted terminal/pending runs have no active index. Only a single-stage
  // run is unambiguous in that case; never guess a multi-stage run's physics.
  const index = execution.active_stage_index ?? (execution.stages.length === 1 ? 0 : null);
  if (index === null || !Number.isInteger(index) || index < 0) return null;
  const record = execution.stages[index];
  if (!record || record.index !== index || !record.stage_id?.trim() ||
    !record.antenna_solve_stage_id?.trim() ||
    !["pending", "running", "completed", "failed", "cancelled"].includes(record.status)) return null;

  const clockKey = record.status === "running" && execution.runtime_state === "running" &&
    validStageTimestamp(record.started_at_unix_ms)
    ? JSON.stringify([execution.session_id, execution.session_epoch,
      execution.request_scope_epoch, execution.run_id, record.stage_id,
      record.antenna_solve_stage_id, record.started_at_unix_ms])
    : null;
  return {
    active: record.status === "running" && execution.runtime_state === "running",
    identityKey: JSON.stringify([execution.session_id, execution.session_epoch,
      execution.request_scope_epoch, execution.run_id, record.stage_id, record.antenna_solve_stage_id, record.index]),
    clockKey, record,
  };
}

function validStageTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function useAntennaStageClock(identity: string | null): number | null {
  const [clock, setClock] = useState<{ identity: string; nowMs: number } | null>(null);
  useEffect(() => {
    if (!identity) return;
    const timer = globalThis.setInterval(() => {
      setClock({ identity, nowMs: Date.now() });
    }, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [identity]);
  return clock?.identity === identity ? clock.nowMs : null;
}

const ANTENNA_PHASE_LABELS = {
  preparing_source: "Preparing source",
  solving_potential: "Solving electric potential",
  reconstructing_current: "Reconstructing current density",
  evaluating_field: "Evaluating Oersted field",
  validating_result: "Validating numerical result",
  publishing_result: "Publishing result",
} as const;

type FooterAntennaProgress = {
  active: boolean;
  percent: number | null;
  samples: string;
};

function readAntennaProgress(record: FooterAntennaStage["record"]) {
  const progress = record.antenna_progress;
  if (!progress || !Object.hasOwn(ANTENNA_PHASE_LABELS, progress.phase) ||
    !Number.isSafeInteger(progress.completed_targets) || progress.completed_targets < 0 ||
    !Number.isSafeInteger(progress.total_targets) || progress.total_targets <= 0 ||
    progress.completed_targets > progress.total_targets ||
    !Number.isSafeInteger(progress.source_cells) || progress.source_cells <= 0 ||
    !Number.isFinite(progress.elapsed_seconds) || progress.elapsed_seconds < 0) return null;
  const phase = progress.phase as keyof typeof ANTENNA_PHASE_LABELS;
  if ((["preparing_source", "solving_potential", "reconstructing_current"].includes(phase) &&
      progress.completed_targets !== 0) ||
    (["validating_result", "publishing_result"].includes(phase) &&
      progress.completed_targets !== progress.total_targets)) return null;
  return { ...progress, phase };
}

function AntennaFieldProgressStrip({ progress, eta }: {
  progress: FooterAntennaProgress;
  eta: AntennaFieldEta;
}) {
  return (
    <div className="fm-footer-telemetry__antenna-progress" data-active={progress.active}>
      <span className="fm-footer-telemetry__antenna-progress-label">Field samples</span>
      <Progress
        value={progress.percent}
        aria-label="Antenna field sampling"
        aria-valuetext={progress.percent === null ? "Progress not reported" : progress.samples}
      />
      <span className="fm-footer-telemetry__antenna-progress-count">
        {progress.percent === null ? "Progress not reported" : progress.samples}
      </span>
      {progress.percent === 100 ? (
        <span className="fm-footer-telemetry__antenna-eta">Field sampling complete</span>
      ) : eta.state === "ready" || eta.state === "estimating" ? (
        <span
          className="fm-footer-telemetry__antenna-eta"
          title="Approximate remaining field evaluation time from recent completed points and elapsed pulses. Point cost varies; validation and publication are excluded."
        >
          {eta.state === "ready"
            ? "Estimated field time left " + formatAntennaFieldEta(eta.seconds)
            : "Estimating field time…"}
        </span>
      ) : null}
    </div>
  );
}

function buildAntennaSolveTelemetry(stage: FooterAntennaStage, nowMs: number | null) {
  const { record } = stage;
  const state = record.status;
  const label = state.charAt(0).toUpperCase() + state.slice(1);
  const reason = record.state_transition_reason ?? record.reason ?? null;
  const numerical = readAntennaProgress(record);
  const start = record.started_at_unix_ms;
  const end = state === "running" ? nowMs : record.completed_at_unix_ms;
  const elapsed = numerical ? formatDuration(numerical.elapsed_seconds)
    : validStageTimestamp(start) && validStageTimestamp(end) && end >= start
      ? formatDuration((end - start) / 1_000) : "Not reported";
  const fieldSamplingStarted = numerical &&
    ["evaluating_field", "validating_result", "publishing_result"].includes(numerical.phase);
  const percent = fieldSamplingStarted ? 100 * numerical.completed_targets / numerical.total_targets : null;
  const samples = numerical
    ? `${INTEGER_FORMAT.format(numerical.completed_targets)} / ${INTEGER_FORMAT.format(numerical.total_targets)}`
    : "Progress not reported";
  const phase = numerical ? ANTENNA_PHASE_LABELS[numerical.phase] : "Progress not reported";
  const publication = state === "failed" ? "Not completed"
    : state === "cancelled" ? "Cancelled"
      : state === "completed" ? "Check saved results"
        : numerical?.phase === "publishing_result" ? "Publishing"
          : state === "pending" ? "Awaiting execution" : "Awaiting result";
  const metric = (id: string, title: string, value: string, detail: string): FooterTelemetryMetric => ({
    id, label: title, value, detail, subdetail: "Authoritative antenna stage execution",
    icon: <Radio size={14} aria-hidden="true" />,
  });
  return {
    antennaProgress: { active: stage.active, percent, samples } satisfies FooterAntennaProgress,
    awaitingCompute: false,
    frequencyDomainProgress: null,
    stageProgressNotice: null,
    metrics: [
      metric("antenna-state", "Solve state", label, reason ? String(reason) : "Antenna field solve lifecycle"),
      metric("antenna-phase", "Phase", phase, "Source preparation, electric solve, current reconstruction, field evaluation and publication"),
      metric("antenna-targets", "Field samples", samples, "Completed observation points; this is not overall stage completion"),
      metric("antenna-source", "Source cells", numerical ? INTEGER_FORMAT.format(numerical.source_cells) : "Not reported", "Conductor cells contributing to the field integral"),
      metric("antenna-elapsed", numerical ? "Operation elapsed" : "Stage elapsed", elapsed,
        numerical
          ? "Wall-clock elapsed since the antenna operation runner started; stage preparation may begin earlier"
          : "Wall-clock duration from the published stage timestamps; not CPU time or LLG simulation time"),
      metric("antenna-results", "Publication", publication, "100% field sampling does not establish publication or saved-result verification"),
    ],
    onlineDetail: "Session state",
    onlineTitle: state === "running" ? "Online / Active" : "Online / Antenna solve",
    statusDetail: reason ? String(reason) : "Antenna field solve lifecycle",
    statusState: state,
    statusTitle: `System Status: Antenna solve — ${label}`,
  };
}

type FooterFrequencyDomainProgress = {
  detail: string;
  frequencyLabel: string | null;
  modeLabel: string | null;
  percent: number | null;
  percentLabel: string;
  pointLabel: string | null;
  rangeLabel: string | null;
  residualLabel: string | null;
  solutionLabel: string | null;
  solveLabel: string | null;
  solverLabel: string | null;
  state: string;
  title: string;
};

function buildFrequencyDomainProgress({
  responseProgress,
  responseSweep,
  solverStageKind,
  stageExecution,
}: {
  responseProgress?: FrequencyDomainSweepProgressResource | null;
  responseSweep?: unknown;
  solverStageKind?: string | null;
  stageExecution?: StageExecutionResource | null;
}): FooterFrequencyDomainProgress | null {
  const activeStage = activeStageRecord(stageExecution);
  const stageKind =
    solverStageKind ??
    stageExecution?.active_stage_kind ??
    activeStage?.kind ??
    null;
  const stageIsFrequencyResponse = isFrequencyResponseStageKind(stageKind);
  const stageIsEigenmodes = isEigenmodesStageKind(stageKind);
  const responseHasProgress =
    responseProgress &&
    (responseProgress.total_frequency_points > 0 ||
      responseProgress.partial_artifacts_available ||
      responseProgress.state === "running");

  if (!stageIsFrequencyResponse && !stageIsEigenmodes && !responseHasProgress) {
    return null;
  }

  const usesResponseProgress = stageIsFrequencyResponse || !stageIsEigenmodes;
  const activeResponseProgress = usesResponseProgress ? responseProgress : null;
  const activeResponseSweep = usesResponseProgress ? responseSweep : null;
  const total = activeResponseProgress?.total_frequency_points ?? null;
  const completed = activeResponseProgress?.completed_frequency_points ?? null;
  const parsedStageProgress = parseFrequencyResponseStageDetail(
    activeStage?.progress_detail,
  );
  const stagePercent =
    typeof activeStage?.progress_percent === "number" &&
    Number.isFinite(activeStage.progress_percent)
      ? activeStage.progress_percent
      : null;
  const jsonOverallPercent = frequencyProgressJsonOverallPercent(
    activeResponseProgress?.progress_json,
  );
  const completedOnlyPercent =
    typeof completed === "number" && typeof total === "number" && total > 0
      ? (completed / total) * 100
      : null;
  const percent = stageIsFrequencyResponse
    ? (jsonOverallPercent ?? stagePercent ?? completedOnlyPercent)
    : (stagePercent ?? jsonOverallPercent ?? completedOnlyPercent);
  const activeDetail =
    activeStage?.progress_detail ?? activeStage?.progress_label ?? null;
  const pointLabel =
    parsedStageProgress.pointLabel ??
    (typeof completed === "number" && typeof total === "number" && total > 0
      ? `point ${Math.min(completed + 1, total)}/${total}`
      : stageIsFrequencyResponse
        ? "waiting for first point"
        : null);
  const rangeLabel =
    parsedStageProgress.rangeLabel ??
    frequencyProgressRangeLabel(activeResponseProgress) ??
    frequencyRangeLabel(activeResponseSweep);
  const currentFrequencyHz =
    typeof activeResponseProgress?.current_frequency_hz === "number" &&
    Number.isFinite(activeResponseProgress.current_frequency_hz)
      ? activeResponseProgress.current_frequency_hz
      : parsedStageProgress.frequencyHz;
  const frequencyLabel =
    currentFrequencyHz !== null
      ? formatFrequencyGHz(currentFrequencyHz)
      : stageIsFrequencyResponse
        ? "pending"
        : null;
  const solverLabel =
    parsedStageProgress.solverLabel ??
    frequencyProgressJsonSolverLabel(activeResponseProgress?.progress_json);
  const solveLabel =
    parsedStageProgress.solveLabel ??
    frequencyProgressJsonSolveLabel(activeResponseProgress?.progress_json);
  const residualLabel =
    parsedStageProgress.residualLabel ??
    frequencyProgressJsonResidualLabel(activeResponseProgress?.progress_json);
  const modeLabel =
    parsedStageProgress.modeLabel ??
    frequencyProgressDemagModeLabel(activeResponseProgress) ??
    frequencyProgressJsonDemagModeLabel(activeResponseProgress?.progress_json);
  const waitingDetail = stageIsFrequencyResponse
    ? "waiting for first frequency point"
    : null;
  const normalizedActiveDetail =
    activeDetail && !activeDetail.toLowerCase().includes("frequency point")
      ? activeDetail
      : null;
  const pointDetail =
    parsedStageProgress.rawPointDetail ??
    (pointLabel && pointLabel !== "waiting for first point" ? pointLabel : null);
  const solutionLabel = frequencyProgressSolutionLabel(pointLabel);
  const detailParts = [
    normalizedActiveDetail,
    modeLabel,
    solutionLabel ?? pointDetail ?? waitingDetail,
    frequencyLabel && frequencyLabel !== "pending" ? frequencyLabel : null,
    solveLabel,
    solverLabel,
    residualLabel,
    rangeLabel ? `range ${rangeLabel}` : null,
  ].filter((part): part is string => Boolean(part));

  return {
    detail: detailParts.join(" · ") || "stage progress pending",
    frequencyLabel,
    modeLabel,
    percent: percent === null ? null : Math.round(percent),
    percentLabel:
      percent === null ? "running" : `${Math.round(percent).toString()}%`,
    pointLabel,
    rangeLabel,
    residualLabel,
    solutionLabel,
    solveLabel,
    solverLabel,
    state: activeResponseProgress?.state ?? activeStage?.status ?? "running",
    title: stageIsEigenmodes
      ? "Eigenmodes"
      : modeLabel
        ? "Demag frequency sweep"
        : "Frequency response",
  };
}

function activeStageRecord(
  stageExecution: StageExecutionResource | null | undefined,
): StageExecutionResource["stages"][number] | null {
  const index = stageExecution?.active_stage_index;
  if (typeof index !== "number") return null;
  return stageExecution?.stages[index] ?? null;
}

function studyHasFrequencyResponseStage(
  solverStageKind: string | null | undefined,
  stageExecution: StageExecutionResource | null | undefined,
): boolean {
  return (
    isFrequencyResponseStageKind(solverStageKind) ||
    isFrequencyResponseStageKind(stageExecution?.active_stage_kind) ||
    (stageExecution?.stages ?? []).some((stage) =>
      isFrequencyResponseStageKind(stage.kind),
    )
  );
}

function isFrequencyResponseStageKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return kind === "frequency_response" || kind === "flat_frequency_response";
}

function isEigenmodesStageKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return kind === "eigenmodes" || kind === "flat_eigenmodes";
}

function frequencyRangeLabel(sweep: unknown): string | null {
  const frequencies = collectFrequenciesHz(sweep).toSorted(
    (left, right) => left - right,
  );
  if (frequencies.length === 0) return null;
  const first = frequencies[0];
  const last = frequencies[frequencies.length - 1];
  if (first === last) return formatFrequencyGHz(first);
  return `${(first / 1.0e9).toFixed(3)}-${formatFrequencyGHz(last)}`;
}

function frequencyProgressRangeLabel(
  progress: FrequencyDomainSweepProgressResource | null | undefined,
): string | null {
  const topLevelRange = frequencyRangeLabelFromValues(
    progress?.frequency_min_hz,
    progress?.frequency_max_hz,
  );
  if (topLevelRange) return topLevelRange;
  const payload = parseJsonRecord(progress?.progress_json);
  return frequencyRangeLabelFromValues(
    numberFromRecord(payload, "frequency_min_hz"),
    numberFromRecord(payload, "frequency_max_hz"),
  );
}

function frequencyRangeLabelFromValues(
  minHz: number | null | undefined,
  maxHz: number | null | undefined,
): string | null {
  if (
    typeof minHz !== "number" ||
    typeof maxHz !== "number" ||
    !Number.isFinite(minHz) ||
    !Number.isFinite(maxHz) ||
    minHz <= 0 ||
    maxHz <= 0 ||
    maxHz < minHz
  ) {
    return null;
  }
  if (minHz === maxHz) return formatFrequencyGHz(minHz);
  return `${(minHz / 1.0e9).toFixed(3)}-${formatFrequencyGHz(maxHz)}`;
}

function parseFrequencyResponseStageDetail(
  detail: string | null | undefined,
): {
  frequencyHz: number | null;
  pointLabel: string | null;
  rawPointDetail: string | null;
  modeLabel: string | null;
  rangeLabel: string | null;
  residualLabel: string | null;
  solveLabel: string | null;
  solverLabel: string | null;
} {
  if (!detail) {
    return {
      frequencyHz: null,
      modeLabel: null,
      pointLabel: null,
      rawPointDetail: null,
      rangeLabel: null,
      residualLabel: null,
      solveLabel: null,
      solverLabel: null,
    };
  }

  const pointMatch = detail.match(/frequency point\s+(\d+)\/(\d+)/i);
  const frequencyMatch = detail.match(/f=([0-9.+-eE]+)\s*GHz/i);
  const rangeMatch = detail.match(/range=([0-9.+-eE]+)-([0-9.+-eE]+)\s*GHz/i);
  const iterationMatch = detail.match(/GMRES iteration=(\d+)(?:\/(\d+))?/i);
  const solveMatch = detail.match(/current frequency solve=([0-9.+-eE]+)%/i);
  const residualMatch = detail.match(/relative residual=([0-9.+-eE]+)/i);
  const demagMatch = detail.match(/demag=([^;]+)/i);
  const frequencyGhz = frequencyMatch ? Number(frequencyMatch[1]) : NaN;
  const rangeMinGhz = rangeMatch ? Number(rangeMatch[1]) : NaN;
  const rangeMaxGhz = rangeMatch ? Number(rangeMatch[2]) : NaN;

  return {
    frequencyHz: Number.isFinite(frequencyGhz) ? frequencyGhz * 1.0e9 : null,
    modeLabel: demagMatch ? demagModeLabel(demagMatch[1]) : null,
    pointLabel: pointMatch ? `point ${pointMatch[1]}/${pointMatch[2]}` : null,
    rawPointDetail: pointMatch ? pointMatch[0] : null,
    rangeLabel:
      Number.isFinite(rangeMinGhz) && Number.isFinite(rangeMaxGhz)
        ? `${rangeMinGhz.toFixed(3)}-${rangeMaxGhz.toFixed(3)} GHz`
        : null,
    residualLabel: residualMatch ? `relres ${residualMatch[1]}` : null,
    solveLabel: solveMatch ? `solve ${solveMatch[1]}%` : null,
    solverLabel: iterationMatch
      ? `GMRES ${iterationMatch[1]}${iterationMatch[2] ? `/${iterationMatch[2]}` : ""}`
      : null,
  };
}

function frequencyProgressDemagModeLabel(
  progress: FrequencyDomainSweepProgressResource | null | undefined,
): string | null {
  return progress?.demag_mode ? demagModeLabel(progress.demag_mode) : null;
}

function frequencyProgressJsonDemagModeLabel(
  progressJson: string | null | undefined,
): string | null {
  const payload = parseJsonRecord(progressJson);
  const rawMode = asString(payload?.demag_mode);
  return rawMode ? demagModeLabel(rawMode) : null;
}

function frequencyProgressJsonSolverLabel(
  progressJson: string | null | undefined,
): string | null {
  const payload = parseJsonRecord(progressJson);
  const iteration = numberFromRecord(payload, "native_iteration_count");
  const maxIterations = numberFromRecord(
    payload,
    "native_max_iterations_for_frequency",
  );
  if (iteration === null) return null;
  const iterationLabel = Math.round(iteration).toString();
  return maxIterations === null
    ? `GMRES ${iterationLabel}`
    : `GMRES ${iterationLabel}/${Math.round(maxIterations).toString()}`;
}

function frequencyProgressJsonSolveLabel(
  progressJson: string | null | undefined,
): string | null {
  const payload = parseJsonRecord(progressJson);
  const solveFraction = numberFromRecord(
    payload,
    "native_current_frequency_solve_fraction",
  );
  if (solveFraction === null) return null;
  const percent = Math.round(Math.max(0, Math.min(1, solveFraction)) * 100);
  return `solve ${percent.toString()}%`;
}

function frequencyProgressJsonResidualLabel(
  progressJson: string | null | undefined,
): string | null {
  const payload = parseJsonRecord(progressJson);
  const residual = numberFromRecord(payload, "native_relative_residual_l2_norm");
  return residual === null ? null : `relres ${residual.toExponential(3)}`;
}

function frequencyProgressJsonOverallPercent(
  progressJson: string | null | undefined,
): number | null {
  const payload = parseJsonRecord(progressJson);
  const completed = numberFromRecord(payload, "completed_frequency_points");
  const total = numberFromRecord(payload, "total_frequency_points");
  const frequencyIndex = numberFromRecord(payload, "native_frequency_index");
  const solveFraction = numberFromRecord(
    payload,
    "native_current_frequency_solve_fraction",
  );
  if (
    completed === null ||
    total === null ||
    frequencyIndex === null ||
    solveFraction === null ||
    total <= 0
  ) {
    return null;
  }
  const completedBeforeCurrent = Math.min(
    Math.max(0, completed),
    Math.max(0, frequencyIndex),
  );
  return Math.max(
    0,
    Math.min(
      100,
      ((completedBeforeCurrent + Math.max(0, Math.min(1, solveFraction))) /
        total) *
        100,
    ),
  );
}

function frequencyProgressSolutionLabel(pointLabel: string | null): string | null {
  if (!pointLabel) return null;
  const match = pointLabel.match(/^point\s+(\d+)\/(\d+)$/i);
  if (!match) return null;
  return `solution ${match[1]}/${match[2]}`;
}

function demagModeLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "periodic_airbox_k0") return "periodic airbox demag";
  if (normalized === "floquet_airbox") return "Floquet airbox demag";
  if (normalized === "enabled") return "demag";
  return `${normalized.replaceAll("_", " ")} demag`;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function numberFromRecord(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function collectFrequenciesHz(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap(collectFrequenciesHz);
  }

  const record = value as Record<string, unknown>;
  const direct = record.frequency_hz;
  const fromDirect =
    typeof direct === "number" && Number.isFinite(direct) ? [direct] : [];
  const fromArrays = ["frequencies_hz", "frequency_hz_values"]
    .flatMap((key) => {
      const item = record[key];
      return Array.isArray(item)
        ? item.filter(
            (entry): entry is number =>
              typeof entry === "number" && Number.isFinite(entry),
          )
        : [];
    });
  const nested = ["points", "samples", "data"]
    .flatMap((key) => collectFrequenciesHz(record[key]));
  return [...fromDirect, ...fromArrays, ...nested];
}

function FrequencyDomainProgressStrip({
  progress,
}: {
  progress: FooterFrequencyDomainProgress;
}) {
  const barWidth = progress.percent ?? 100;
  const chips = [
    progress.solutionLabel ?? progress.pointLabel,
    progress.frequencyLabel,
    progress.modeLabel,
    progress.rangeLabel,
  ].filter((l): l is string => Boolean(l));

  return (
    <div className="fm-footer-telemetry__freq-strip">
      <span className="fm-footer-telemetry__freq-strip-title">{progress.title}</span>
      {chips.length > 0 ? (
        <span
          className="fm-footer-telemetry__freq-strip-chip"
          aria-label={chips[0]}
          title={chips[0]}
        >
          {chips[0]}
        </span>
      ) : null}
      <div
        aria-label={progress.title}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.percent ?? undefined}
        role="progressbar"
        className={
          progress.percent === null
            ? "fm-footer-telemetry__freq-strip-track fm-footer-telemetry__freq-strip-track--indeterminate"
            : "fm-footer-telemetry__freq-strip-track"
        }
      >
        <span
          className="fm-footer-telemetry__freq-strip-bar"
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <span className="fm-footer-telemetry__freq-strip-percent">{progress.percentLabel}</span>
    </div>
  );
}

function resolveLiveSampleForStatus(
  status: FooterTelemetryStatus | null | undefined,
  liveSample: FooterLiveScalarSample | null | undefined,
  terminalRun = isTerminalFooterSolverState(status?.solver.state),
): FooterLiveScalarSample | null {
  if (!liveSample || !status?.sessionId || !status.run?.run_id) return null;
  if (
    !liveSample.requestScopeEpoch ||
    liveSample.requestScopeEpoch !== status.requestScopeEpoch ||
    liveSample.sessionId !== status.sessionId ||
    liveSample.runId !== status.run.run_id
  ) {
    return null;
  }
  const rowStep = scalarSampleNumber(liveSample.row, "step");
  const sampleStep = rowStep ?? liveSample.step;
  if (rowStep !== null && rowStep !== liveSample.step) return null;
  if (
    terminalRun &&
    Number.isFinite(status.run.solver_steps) &&
    Number.isFinite(sampleStep) &&
    sampleStep !== status.run.solver_steps
  ) {
    return null;
  }
  return liveSample;
}

export function resolveFooterScalarResourceSample(
  status: FooterTelemetryStatus | null | undefined,
  window: ScalarWindowResource | null | undefined,
): FooterScalarResourceSample | null {
  const source = window?.current_observation;
  const values = window?.rows[0];
  if (!status?.sessionId || !status.run?.run_id || !window || !source || !values ||
      window.rows.length !== 1 || window.returned_rows !== 1 ||
      source.session_id !== status.sessionId || source.run_id !== status.run.run_id ||
      source.request_scope_epoch !== status.requestScopeEpoch ||
      !Number.isSafeInteger(window.revision) || window.revision < 0 ||
      source.scalar_revision !== window.revision ||
      !Number.isSafeInteger(source.source_step) || source.source_step < 0 ||
      values.length !== window.columns.length) return null;
  const row: Record<string, number> = {};
  for (const [index, column] of window.columns.entries()) {
    const value = values[index];
    if (typeof value === "number" && Number.isFinite(value)) row[column] = value;
  }
  if (row.step !== source.source_step || scalarSampleMagnetization(row) === null) return null;
  return { revision: window.revision, row, runId: source.run_id, sessionId: source.session_id };
}

function resolveFooterCurrentRun(
  status: FooterTelemetryStatus | null | undefined,
  currentRun: CurrentRunResource | null | undefined,
): CurrentRunResource | null {
  if (
    !status?.run?.run_id ||
    !currentRun ||
    currentRun.session_id !== status.sessionId ||
    currentRun.run_id !== status.run.run_id
  ) {
    return null;
  }
  return currentRun;
}

function resolveFooterSolverStatus(
  status: FooterTelemetryStatus | null | undefined,
  solverStatus: SolverStatusResource | null | undefined,
): SolverStatusResource | null {
  if (!status?.run?.run_id || solverStatus?.run_id !== status.run.run_id) {
    return null;
  }
  return solverStatus;
}

export function resolveFooterRuntimeRelaxationAlgorithm(
  status: FooterTelemetryStatus | null | undefined,
  solverStatus?: SolverStatusResource | null,
  stageExecution?: StageExecutionResource | null,
): FooterRelaxationAlgorithm | null {
  if (!status?.run?.run_id) return null;
  const currentSolverStatus = resolveFooterSolverStatus(status, solverStatus);
  const currentStageMethod = resolveFooterActiveStageMethod(status, stageExecution);
  const stageAlgorithm = normalizeFooterStageMethod(currentStageMethod);
  if (stageAlgorithm) return stageAlgorithm;
  const candidates = [
    currentSolverStatus?.relaxation_algorithm,
    status.solver.relaxation_algorithm,
    currentSolverStatus?.algorithm,
    status.solver.algorithm,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeFooterRelaxationAlgorithm(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function resolveFooterActiveStageMethod(
  status: FooterTelemetryStatus,
  stageExecution: StageExecutionResource | null | undefined,
): string | null {
  if (
    !stageExecution ||
    stageExecution.session_id !== status.sessionId ||
    stageExecution.session_epoch !== status.sessionEpoch ||
    stageExecution.request_scope_epoch !== status.requestScopeEpoch ||
    stageExecution.run_id !== status.run?.run_id ||
    !isRuntimeStateActive(stageExecution.runtime_state) ||
    !Number.isSafeInteger(stageExecution.active_stage_index)
  ) {
    return null;
  }
  const activeStage = stageExecution.stages.find(
    (stage) => stage.index === stageExecution.active_stage_index,
  );
  if (
    !activeStage ||
    !["active", "running"].includes(activeStage.status.trim().toLowerCase())
  ) {
    return null;
  }
  return activeStage.current_settle_step_method ?? null;
}

function normalizeFooterRelaxationAlgorithm(
  value: unknown,
): FooterRelaxationAlgorithm | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return FOOTER_RELAXATION_ALGORITHMS.has(normalized as FooterRelaxationAlgorithm)
    ? normalized as FooterRelaxationAlgorithm
    : null;
}

function normalizeFooterStageMethod(value: string | null): FooterRelaxationAlgorithm | null {
  if (isFooterLlgRuntimeStageMethod(value)) return "llg_overdamped";
  return normalizeFooterRelaxationAlgorithm(value);
}

function isFooterLlgRuntimeStageMethod(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "llg_overdamped" || normalized === "heun_dynamics_settle";
}

function describeFooterSolverAlgorithm(
  algorithm: FooterRelaxationAlgorithm | null,
  integrator: string | null | undefined,
  stageMethod: string | null,
): { detail: string; value: string } | null {
  if (stageMethod?.trim().toLowerCase() === "heun_dynamics_settle") {
    return {
      detail: "Landau–Lifshitz–Gilbert overdamped with Heun integrator",
      value: "LLG + HEUN",
    };
  }
  switch (algorithm) {
    case "projected_gradient_bb":
      return { detail: "Barzilai–Borwein direct minimizer", value: "BB" };
    case "nonlinear_cg":
      return { detail: "Nonlinear conjugate-gradient direct minimizer", value: "NCG" };
    case "tangent_plane_implicit":
      return { detail: "Tangent-plane implicit direct minimizer", value: "TPI" };
    case "llg_overdamped": {
      const activeIntegrator = integrator?.trim() || null;
      return {
        detail: activeIntegrator
          ? `Landau–Lifshitz–Gilbert overdamped with ${activeIntegrator} integrator`
          : "Landau–Lifshitz–Gilbert overdamped",
        value: activeIntegrator ? `LLG + ${activeIntegrator.toUpperCase()}` : "LLG",
      };
    }
    default: {
      const runtimeIntegrator = integrator?.trim() || null;
      return runtimeIntegrator
        ? {
            detail: `Runtime integrator ${runtimeIntegrator}`,
            value: runtimeIntegrator.toUpperCase(),
          }
        : null;
    }
  }
}

function isTerminalFooterSolverState(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return TERMINAL_FOOTER_SOLVER_STATES.has(value.trim().toLowerCase());
}

export function resolveFooterMagneticModelPresent(
  scene: Pick<ResourceResult<SceneResource>, "data" | "status">,
): boolean | null {
  if ((scene.status !== "ready" && scene.status !== "stale") || !Array.isArray(scene.data?.objects)) return null;
  return !scene.data.objects.every(hasEmptyObjectMagneticModel);
}

export function resolvePrimaryTelemetryObjectId(
  scene: SceneResource | null | undefined,
  selectedObjectId?: string | null,
): string | null {
  const objects = scene?.objects ?? [];
  const selected = objects.find((object) => object.id === selectedObjectId);
  // An explicitly selected empty model must not borrow another object's metrics.
  if (selected) return hasEmptyObjectMagneticModel(selected) ? null : selected.id;
  return objects.find((object) => !hasEmptyObjectMagneticModel(object))?.id ?? null;
}

type FooterTelemetryGroup = "runtime" | "solver" | "magnetization" | "energy";

const FOOTER_TELEMETRY_GROUP_ORDER: readonly FooterTelemetryGroup[] = ["runtime", "solver", "magnetization", "energy"];

const FOOTER_TELEMETRY_GROUP_LABELS: Record<FooterTelemetryGroup, string> = {
  runtime: "Runtime",
  solver: "Solver",
  magnetization: "Magnetization",
  energy: "Energy",
};

function metricGroup(id: string): FooterTelemetryGroup {
  if (id.startsWith("energy-")) return "energy";
  if (id === "avg-mx" || id === "avg-my" || id === "avg-mz" || id === "avg-m") return "magnetization";
  if (id === "solver-progress" || id === "step" || id === "dt" || id === "active-solver" || id === "solver-error" || id === "solver-max-error" || id === "max-torque") return "solver";
  return "runtime";
}

/**
 * One readout: label and value only. Provenance and method notes live in a
 * contextual tooltip (hover or keyboard focus) so the dock stays one or two
 * rows tall instead of growing with expandable descriptions.
 */
function TelemetryMetric({
  detail,
  group,
  label,
  subdetail,
  unit,
  value,
  visual,
}: {
  detail: string;
  group: FooterTelemetryGroup;
  label: string;
  subdetail: string;
  unit?: string;
  value: string;
  /** Optional inline visual (a diverging bar) between label and value. */
  visual?: ReactNode;
}) {
  const reading = `${value}${unit ? ` ${unit}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="fm-footer-telemetry__metric"
          data-group={group}
          role="group"
          tabIndex={0}
          aria-label={`${label}: ${reading}`}
        >
          <span className="fm-footer-telemetry__metric-label">{label}</span>
          {visual}
          <span className="fm-footer-telemetry__metric-value">
            <span className="fm-footer-telemetry__metric-number">{value}</span>
            {unit ? <span className="fm-footer-telemetry__metric-unit">{unit}</span> : null}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent
        className="fm-footer-telemetry__tooltip"
        data-group={group}
        side="top"
        align="start"
      >
        <span className="fm-footer-telemetry__tooltip-head">
          <span className="fm-footer-telemetry__tooltip-label">{label}</span>
          <span className="fm-footer-telemetry__tooltip-group">{FOOTER_TELEMETRY_GROUP_LABELS[group]}</span>
        </span>
        <span className="fm-footer-telemetry__tooltip-value">{reading}</span>
        <span className="fm-footer-telemetry__tooltip-detail">{detail}</span>
        {subdetail ? <span className="fm-footer-telemetry__tooltip-detail">{subdetail}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scalarSampleNumber(
  row: Record<string, number> | null,
  key: string,
): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}

function scalarSampleMagnetization(
  row: Record<string, number> | null,
): { mx: number; my: number; mz: number } | null {
  const mx = scalarSampleNumber(row, "mx");
  const my = scalarSampleNumber(row, "my");
  const mz = scalarSampleNumber(row, "mz");
  if (mx === null || my === null || mz === null) return null;
  return { mx, my, mz };
}

function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";

  const elapsedSeconds = Math.max(0, seconds);
  if (elapsedSeconds < 60) return `${elapsedSeconds.toFixed(3)} s`;

  const totalSeconds = Math.floor(elapsedSeconds);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = (elapsedSeconds % 60).toFixed(3).padStart(6, "0");
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m ${remainingSeconds}s`
    : `${minutes}m ${remainingSeconds}s`;
}

function formatFixed(
  value: number | null | undefined,
  digits: number,
  fallback: string,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : fallback;
}

function formatInteger(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? INTEGER_FORMAT.format(value)
    : "—";
}

function formatFrequencyGHz(valueHz: number): string {
  return `${(valueHz / 1.0e9).toFixed(3)} GHz`;
}

function formatScientific(
  value: number | null | undefined,
  fallback: string,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (Math.abs(value) >= 1e-2 && Math.abs(value) < 1e4) {
    return COMPACT_DECIMAL_FORMAT.format(value);
  }
  return value.toExponential(6);
}

function formatTorqueTelemetry(valueT: number | null | undefined): string {
  return typeof valueT === "number" && Number.isFinite(valueT)
    ? formatTorqueT(valueT)
    : "—";
}

function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* -- Telemetry board (mockup dock) --
 * Run: simulated time as the hero reading with the active stage and its
 * runtime-reported progress. Magnetization: diverging bars for <m>.
 * Solver and Energy: readouts with sparklines of samples observed in this
 * run. Nothing is illustrative: absent data leaves the visual out. */

type FooterStageProgress = {
  index: number;
  label: string | null;
  percent: number | null;
  total: number;
};

function resolveFooterStageProgress(
  stageExecution: StageExecutionResource | null | undefined,
): FooterStageProgress | null {
  const record = activeStageRecord(stageExecution);
  if (!stageExecution || !record || !(stageExecution.total_stages > 0)) return null;
  const percent = typeof record.progress_percent === "number" && Number.isFinite(record.progress_percent)
    ? Math.min(100, Math.max(0, record.progress_percent))
    : null;
  return {
    index: record.index + 1,
    label: record.progress_label ?? record.label ?? record.kind ?? null,
    percent,
    total: stageExecution.total_stages,
  };
}

type TelemetryHistory = { energy: readonly number[]; torque: readonly number[] };
const HISTORY_LIMIT = 120;
const EMPTY_HISTORY: TelemetryHistory = { energy: [], torque: [] };

/** Keeps the readings observed in the current run, one point per new sim time. */
function useTelemetryHistory(
  runId: string | null,
  simTime: number | null,
  energy: number | null,
  torque: number | null,
): TelemetryHistory {
  const [state, setState] = useState<{ runId: string | null; time: number | null; history: TelemetryHistory }>(
    { runId: null, time: null, history: EMPTY_HISTORY },
  );
  // Derived during render: a new run resets the series, a new sim time appends.
  const base = state.runId === runId ? state : { runId, time: null, history: EMPTY_HISTORY };
  if (base !== state || (simTime !== null && simTime !== base.time)) {
    const push = (series: readonly number[], value: number | null) =>
      value === null ? series : [...series, value].slice(-HISTORY_LIMIT);
    setState(simTime === null || simTime === base.time ? base : {
      runId,
      time: simTime,
      history: { energy: push(base.history.energy, energy), torque: push(base.history.torque, torque) },
    });
  }
  return state.runId === runId ? state.history : EMPTY_HISTORY;
}

function TelemetrySparkline({ label, log = false, values }: { label: string; log?: boolean; values: readonly number[] }) {
  const points = log ? values.filter((value) => value > 0).map((value) => Math.log10(value)) : values;
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const path = points
    .map((value, index) => `${index ? "L" : "M"}${((index / (points.length - 1)) * 100).toFixed(2)},${(28 - ((value - min) / span) * 26).toFixed(2)}`)
    .join(" ");
  return (
    <svg aria-label={label} className="fm-footer-telemetry__spark" preserveAspectRatio="none" role="img" viewBox="0 0 100 30">
      <path className="fm-footer-telemetry__spark-area" d={`${path} L100,30 L0,30 Z`} />
      <path className="fm-footer-telemetry__spark-line" d={path} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function DivergingBar({ value }: { value: number | null | undefined }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return <span className="fm-footer-telemetry__diverge" aria-hidden="true" />;
  }
  const width = Math.min(1, Math.abs(value)) * 50;
  return (
    <span className="fm-footer-telemetry__diverge" aria-hidden="true">
      <span
        className="fm-footer-telemetry__diverge-fill"
        style={{ left: value >= 0 ? "50%" : `${50 - width}%`, width: `${width}%` }}
      />
    </span>
  );
}

const MAGNETIZATION_AXES = new Set(["avg-mx", "avg-my", "avg-mz"]);

function TelemetryBoardGroup({
  history,
  id,
  metrics,
  stage,
}: {
  history: TelemetryHistory;
  id: FooterTelemetryGroup;
  metrics: readonly FooterTelemetryMetric[];
  stage: FooterStageProgress | null;
}) {
  const hero = id === "runtime" ? metrics.find((metric) => metric.id === "time") : undefined;
  const rows = metrics.filter((metric) => metric !== hero);
  return (
    <section
      className="fm-footer-telemetry__group"
      data-group={id}
      aria-label={`${FOOTER_TELEMETRY_GROUP_LABELS[id]} metrics`}
    >
      <header className="fm-footer-telemetry__group-head">
        <h3 className="fm-footer-telemetry__group-title">{FOOTER_TELEMETRY_GROUP_LABELS[id]}</h3>
        {stage ? (
          <span className="fm-footer-telemetry__stage-badge">Stage {stage.index}/{stage.total}</span>
        ) : null}
      </header>
      {hero ? (
        <div className="fm-footer-telemetry__hero" title={hero.detail}>
          <span className="fm-footer-telemetry__hero-value">{hero.value}</span>
          <span className="fm-footer-telemetry__hero-unit">{hero.unit ? `${hero.unit} · ` : ""}{hero.label}</span>
        </div>
      ) : null}
      {stage && stage.percent !== null ? (
        <div className="fm-footer-telemetry__stage-progress">
          <Progress
            aria-label={`Stage ${stage.index} of ${stage.total} progress`}
            className="fm-footer-telemetry__stage-bar"
            value={stage.percent}
          />
          <span className="fm-footer-telemetry__stage-label">
            {stage.label ? `${stage.label} · ` : ""}{Math.round(stage.percent)}%
          </span>
        </div>
      ) : null}
      <div className="fm-footer-telemetry__rows" data-columns={id === "runtime" || id === "solver" ? 2 : 1}>
        {rows.map((metric) => (
          <TelemetryMetric
            key={metric.id}
            detail={metric.detail}
            group={id}
            label={metric.label}
            subdetail={metric.subdetail}
            unit={metric.unit}
            value={metric.value}
            visual={MAGNETIZATION_AXES.has(metric.id) ? <DivergingBar value={metric.numeric} /> : undefined}
          />
        ))}
      </div>
      {id === "energy" ? <TelemetrySparkline label="Total energy observed in this run" values={history.energy} /> : null}
      {id === "solver" ? <TelemetrySparkline label="Max torque observed in this run, log scale" log values={history.torque} /> : null}
    </section>
  );
}
