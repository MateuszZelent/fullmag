import { type FooterTelemetryStatus, type FooterScalarAttemptReference, resolveFooterSolverStatus, resolveFooterAntennaStage, resolveFooterMeanTimestep, resolveFooterScalarResourceSample, resolveFooterActiveStageMethod, resolveFooterRuntimeRelaxationAlgorithm, scalarSampleNumber, isFooterLlgRuntimeStageMethod, scalarSampleMagnetization, type FooterAntennaStage, validStageTimestamp, type FooterRelaxationAlgorithm } from "./FooterTelemetry.model";
import type { FrequencyDomainSweepProgressResource, ObjectMetricsResource, RunPerformanceResource, ScalarWindowResource, SolverStatusResource, StageExecutionResource } from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { formatRuntimeStateLabel, formatRuntimeUserSolvePhaseLabel, isRuntimeStateActive, isRuntimeStateWaitingForCompute, resolveEffectiveRuntimeState, type RuntimeUserSolvePhase } from "@/kernel/runtime/runtimeStateDisplay";
import { footerPerformanceMatchesScalarSeries, footerPerformanceStageMatches, resolveFooterPerformanceClock, resolveFooterPerformanceRate, resolveFooterPerformanceStep, type FooterPerformanceStageReference } from "./footerPerformanceProgress";
import { Clock3, Gauge, Hash, Magnet, Radio, Zap } from "lucide-react";
import { formatTorqueT } from "@/shared/domain/physics/torqueUnits";
import type { ReactNode } from "react";
import type { KernelEventMap } from "@/kernel/events/eventTypes";

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

export type FooterLiveScalarSample = KernelEventMap["telemetry:scalar-sample"];

export const STAGE_PROGRESS_NOT_PUBLISHED_LABEL =
  "Stage progress not published by this runtime";

export type FooterTelemetryMetric = {
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
    scalarHistory?: ScalarWindowResource | null;
    runtimeIntegrator?: string | null;
    stageProgressAvailable?: boolean;
    stageReference?: FooterPerformanceStageReference | null;
    nowMs?: number | null;
    stageExecutionUnpublished?: boolean;
    stageHandoff?: boolean;
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

  const stageHandoff = runtimePhase?.stageHandoff === true;
  const completedRun = !stageHandoff && (
    isTerminalFooterSolverState(status.solver.state) ||
    isTerminalFooterSolverState(runtimePhase?.currentRunStatus)
  );
  const liveSampleForStatus = stageHandoff
    ? null
    : resolveLiveSampleForStatus(status, liveSample, completedRun);
  const resourceSample = stageHandoff
    ? null
    : resolveFooterScalarResourceSample(status, scalarWindow);
  const performanceForTelemetry = stageHandoff ? null : runtimePhase?.performance;
  const scalarSample = !resourceSample ||
      (completedRun && resourceSample.row.step !== status.run?.solver_steps) ||
      (liveSampleForStatus && typeof liveSampleForStatus.revision === "number" &&
        resourceSample.revision <= liveSampleForStatus.revision)
    ? liveSampleForStatus
    : resourceSample;
  const liveRow = scalarSample?.row ?? null;
  const runSolverStatus = resolveFooterSolverStatus(status, solverStatus);
  const stageReference = runtimePhase?.stageReference ?? undefined;
  const performanceClock = resolveFooterPerformanceClock(
    status.run?.run_id, performanceForTelemetry, stageReference, resourceSample?.series,
  );
  const observedSolverStep = resolveFooterPerformanceStep(
    status.run?.run_id, performanceForTelemetry, stageReference, resourceSample?.series,
  );
  const performanceMatchesStage = footerPerformanceStageMatches(
    runtimePhase?.performance, stageReference,
  ) && footerPerformanceMatchesScalarSeries(
    runtimePhase?.performance, resourceSample?.series,
  );
  const performanceAttempt = observedSolverStep === null
    ? null
    : performanceAttemptReference(performanceForTelemetry);
  const runtimeState = stageHandoff
    ? "running"
    : resolveEffectiveRuntimeState({
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
    runSolverStatus?.integrator?.trim() || runtimePhase?.runtimeIntegrator,
    activeStageMethod,
  );
  const activeSolverExecution = Boolean(status.run?.run_id) &&
    (isRuntimeStateActive(runtimeState) || activeStageMethod !== null);
  const simTimeSeconds = stageHandoff
    ? status.run?.solver_time ?? null
    : (performanceClock?.timeSeconds ??
        (completedRun
          ? status.run?.solver_time ??
            runSolverStatus?.sim_time_seconds ??
            scalarSampleNumber(liveRow, "time")
          : scalarSampleNumber(liveRow, "time") ??
            runSolverStatus?.sim_time_seconds ??
            status.run?.solver_time)) ?? null;
  const currentStageIsLlg = isFooterLlgRuntimeStageMethod(activeStageMethod);
  const pseudoTimeSeconds = stageHandoff || currentStageIsLlg
    ? null
    : scalarSampleNumber(liveRow, "pseudo_time_s") ??
      runSolverStatus?.pseudo_time_seconds ??
      null;
  const activeRuntimeSeconds =
    scalarSampleNumber(liveRow, "active_runtime_s") ??
    objectNumber(runSolverStatus, "active_runtime_seconds") ??
    null;
  const usesPseudoTime = !stageHandoff &&
    runtimeRelaxationAlgorithm !== null &&
    runtimeRelaxationAlgorithm !== "llg_overdamped" &&
    pseudoTimeSeconds !== null;
  const directMinimizerWithoutPseudoTime = !stageHandoff &&
    runtimeRelaxationAlgorithm !== null &&
    runtimeRelaxationAlgorithm !== "llg_overdamped" &&
    !usesPseudoTime;
  const primaryTimeSeconds = usesPseudoTime
    ? pseudoTimeSeconds
    : directMinimizerWithoutPseudoTime
      ? null
      : simTimeSeconds;
  const totalSteps = stageHandoff
    ? status.run?.solver_steps ?? status.metrics.total_steps
    : (completedRun
        ? status.run?.solver_steps ??
          runSolverStatus?.step_index ??
          status.metrics.total_steps
        : scalarSampleNumber(liveRow, "step") ??
          runSolverStatus?.step_index ??
          status.run?.solver_steps ??
          status.metrics.total_steps) ?? null;
  const measuredRate = resolveFooterPerformanceRate(
    status.run?.run_id,
    performanceForTelemetry,
    resourceSample?.series,
    stageReference,
  );
  const stepsPerSecond = status.metrics.steps_per_second;
  const maxTorqueT =
    scalarSampleNumber(liveRow, "max_torque_T") ??
    runSolverStatus?.max_torque_T ??
    status?.solver?.max_torque_T;
  const reportedDt = stageHandoff || usesPseudoTime
    ? null
    : performanceClock?.dtSeconds ??
      scalarSampleNumber(liveRow, "solver_dt") ??
      scalarSampleNumber(liveRow, "dt") ??
      runSolverStatus?.dt_seconds ??
      status?.solver?.dt;
  const activeClockSeconds = usesPseudoTime
    ? pseudoTimeSeconds
    : performanceClock?.timeSeconds ?? scalarSampleNumber(liveRow, "time") ?? simTimeSeconds;
  const matchedSolverDtIsAuthoritative = !usesPseudoTime &&
    performanceClock !== null &&
    reportedDt === performanceClock.dtSeconds;
  const zeroDtIsUnpublished = !matchedSolverDtIsAuthoritative &&
    reportedDt === 0 &&
    typeof activeClockSeconds === "number" && activeClockSeconds > 0;
  const dt = typeof reportedDt === "number" && Number.isFinite(reportedDt) &&
      (reportedDt > 0 || (reportedDt === 0 && !zeroDtIsUnpublished))
    ? reportedDt
    : null;
  const scalarAttempt = scalarSample === resourceSample ? resourceSample?.series ?? null : null;
  const expectedScalarAttempt = performanceAttempt ?? undefined;
  const expectedStageId = stageReference?.stageId ?? null;
  const meanTimestep = directMinimizerWithoutPseudoTime
    ? null
    : resolveFooterMeanTimestep(
        status,
        runtimePhase?.scalarHistory,
        usesPseudoTime ? "pseudo_time_s" : "time",
        expectedScalarAttempt,
        expectedStageId,
      );
  const scalarSampleMatchesPerformance = !performanceAttempt || Boolean(scalarAttempt &&
    sameFooterAttempt(performanceAttempt, scalarAttempt));
  const validReportedDt = performanceClock || scalarSampleMatchesPerformance ? dt : null;
  const resolvedDt = validReportedDt ?? meanTimestep?.secondsPerStep ?? null;
  const usesMeanTimestep = validReportedDt === null && meanTimestep !== null;
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
  const physicalTimeSource = stageHandoff
    ? "Run physical time · stage handoff"
    : performanceClock
      ? `Solver update · step ${formatInteger(performanceClock.stepIndex)} · Attempt ${performanceClock.attemptId}${performanceFreshness(runtimePhase)}`
    : completedRun
      ? "Current run status"
      : liveRow
        ? scalarResourceTimeSource(resourceSample, scalarSample === resourceSample)
      : runSolverStatus
        ? "Source: solver status"
        : status
          ? "Source: session status"
          : "Source unavailable";
  const pseudoTimeSource = liveRow && scalarSampleNumber(liveRow, "pseudo_time_s") !== null
    ? scalarResourceTimeSource(resourceSample, scalarSample === resourceSample)
    : runSolverStatus?.pseudo_time_seconds !== null && runSolverStatus?.pseudo_time_seconds !== undefined
      ? "Source: solver status pseudotime"
      : "Source unavailable";
  const timeSource = usesPseudoTime ? pseudoTimeSource : physicalTimeSource;
  const primaryTimeDisplay = formatFooterSimulationTime(primaryTimeSeconds);
  const simTimeDisplay = formatFooterSimulationTime(simTimeSeconds);
  const displayedStepTimeSeconds = completedRun
    ? simTimeSeconds
    : liveRow
      ? scalarSampleNumber(liveRow, usesPseudoTime ? "pseudo_time_s" : "time")
      : usesPseudoTime
        ? pseudoTimeSeconds
        : performanceClock?.timeSeconds ?? objectMetrics?.time_seconds ?? simTimeSeconds;
  const displayedStepTime = formatFooterSimulationTime(displayedStepTimeSeconds);
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
    runtimePhase.stageProgressAvailable !== true &&
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
        unit: directMinimizerWithoutPseudoTime ? undefined : primaryTimeDisplay.unit,
        value: directMinimizerWithoutPseudoTime ? "—" : primaryTimeDisplay.value,
        numeric: finiteOrNull(primaryTimeSeconds),
      },
      ...(usesPseudoTime
        ? [
            {
              detail: "Physical simulation time",
              icon: <Clock3 size={14} aria-hidden="true" />,
              id: "sim-time",
              label: "Sim time",
              subdetail: physicalTimeSource,
              unit: simTimeDisplay.unit,
              value: simTimeDisplay.value,
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
        detail: "Closed end-to-end runner span",
        icon: <Radio size={14} aria-hidden="true" />,
        id: "rate",
        label: "End-to-end rate",
        subdetail: `${formatInteger(totalSteps)} steps`,
        unit: "steps/s",
        value: formatFixed(stepsPerSecond, 1, "—"),
      },

      {
        detail: performanceMatchesStage
          ? "Measured current-stage step span over monotonic attempt time"
          : "Measured identified-attempt step span over monotonic time",
        icon: <Radio size={14} aria-hidden="true" />,
        id: "stage-rate",
        label: performanceMatchesStage ? "Stage rate" : "Attempt rate",
        subdetail: measuredRate
          ? `Steps ${formatInteger(measuredRate.firstStep)}–${formatInteger(measuredRate.lastStep)} · ${formatDuration(measuredRate.elapsedSeconds)} · Attempt ${measuredRate.attemptId}${performanceFreshness(runtimePhase)}`
          : runtimePhase?.performanceRefreshFailed
            ? "No matching measured span · refresh unavailable"
            : "No matching measured stage span available",
        unit: "steps/s",
        value: formatFixed(measuredRate?.stepsPerSecond, 1, "—"),
      },

      ...(observedSolverStep !== null ? [{
        detail: performanceMatchesStage
          ? "Last backend-reported solver step for the current stage attempt. Field and scalar sample clocks are independent."
          : "Last backend-reported solver step for this identified attempt. Field and scalar sample clocks are independent.",
        icon: <Hash size={14} aria-hidden="true" />,
        id: "solver-progress",
        label: "Solver step",
        subdetail: `${performanceMatchesStage ? status.run?.stage_label || "Current stage" : "Recorded attempt"} · Attempt ${runtimePhase?.performance?.attempt_id ?? "unknown"} · ${
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
        detail: observedSolverStep !== null && scalarSampleNumber(liveRow, "step") !== null
          ? "Step of the displayed scalar observation"
          : "Latest step",
        icon: <Hash size={14} aria-hidden="true" />,
        id: "step",
        label: observedSolverStep !== null && scalarSampleNumber(liveRow, "step") !== null
          ? "Sample step"
          : "Step",
        subdetail: directMinimizerWithoutPseudoTime
          ? "Physical time not applicable"
          : `${usesPseudoTime ? "τ" : "t"}=${displayedStepTime.value}${displayedStepTime.unit ? ` ${displayedStepTime.unit}` : ""}${scalarAttempt?.attempt_id ? ` · Attempt ${scalarAttempt.attempt_id}` : ""}`,
        value: formatInteger(
          completedRun ? totalSteps : liveRow
            ? scalarSampleNumber(liveRow, "step") ?? totalSteps
            : objectMetrics?.step ?? totalSteps,
        ),
        unit: "steps",
      },
      {
        detail: usesPseudoTime
          ? usesMeanTimestep
            ? "Mean minimizer pseudotime step over accepted scalar samples"
            : "Minimizer pseudotime step"
          : directMinimizerWithoutPseudoTime
            ? `${runtimeSolverDescription?.value ?? "Direct minimizer"} does not publish a physical timestep`
            : usesMeanTimestep
              ? "Mean physical timestep over accepted scalar samples"
              : "Solver timestep",
        icon: <Clock3 size={14} aria-hidden="true" />,
        id: "dt",
        label: usesMeanTimestep
          ? usesPseudoTime ? "Mean pseudo dt" : "Mean dt"
          : usesPseudoTime ? "Pseudo dt" : "dt",
        subdetail: directMinimizerWithoutPseudoTime
          ? "Not applicable: no physical timestep is used"
          : meanTimestep && usesMeanTimestep
            ? `Steps ${formatInteger(meanTimestep.firstStep)}–${formatInteger(meanTimestep.lastStep)} · ${formatInteger(meanTimestep.stepCount)} sample span · Attempt ${meanTimestep.attemptId}`
            : performanceClock
              ? `Solver step ${formatInteger(performanceClock.stepIndex)} · Attempt ${performanceClock.attemptId}`
              : scalarSampleMatchesPerformance && scalarAttempt?.attempt_id
                ? `Scalar sample · Attempt ${scalarAttempt.attempt_id}`
                : `State: ${runtimeStateLabel}`,
        unit: directMinimizerWithoutPseudoTime ? undefined : "s",
        value: formatScientific(directMinimizerWithoutPseudoTime ? null : resolvedDt, "—"),
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
      (runtimePhase?.magneticModelPresent !== false ||
        (metric.id !== "max-torque" && metricGroup(metric.id) !== "magnetization" &&
          metricGroup(metric.id) !== "energy")) &&
      (!stageHandoff || !["step", "dt", "stage-rate", "solver-progress"].includes(metric.id)),
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

const ANTENNA_PHASE_LABELS = {
  preparing_source: "Preparing source",
  solving_potential: "Solving electric potential",
  reconstructing_current: "Reconstructing current density",
  evaluating_field: "Evaluating Oersted field",
  validating_result: "Validating numerical result",
  publishing_result: "Publishing result",
} as const;

export type FooterAntennaProgress = {
  active: boolean;
  percent: number | null;
  samples: string;
};

export function readAntennaProgress(record: FooterAntennaStage["record"]) {
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

export type FooterFrequencyDomainProgress = {
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

export function activeStageRecord(
  stageExecution: StageExecutionResource | null | undefined,
): StageExecutionResource["stages"][number] | null {
  const index = stageExecution?.active_stage_index;
  if (typeof index !== "number") return null;
  return stageExecution?.stages[index] ?? null;
}

export function isFrequencyResponseStageKind(kind: string | null | undefined): boolean {
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

function performanceAttemptReference(
  performance: RunPerformanceResource | null | undefined,
): FooterScalarAttemptReference | null {
  if (!performance || !performance.run_id || !performance.task_id ||
      !performance.step_id || !performance.attempt_id ||
      !Number.isSafeInteger(performance.ownership_epoch) ||
      (performance.ownership_epoch ?? -1) < 0) return null;
  return {
    run_id: performance.run_id,
    task_id: performance.task_id,
    step_id: performance.step_id,
    attempt_id: performance.attempt_id,
    ownership_epoch: performance.ownership_epoch!,
  };
}

function sameFooterAttempt(
  expected: FooterScalarAttemptReference,
  observed: NonNullable<ScalarWindowResource["series"]>,
): boolean {
  return expected.run_id === observed.run_id &&
    expected.task_id === observed.task_id &&
    expected.step_id === observed.step_id &&
    expected.attempt_id === observed.attempt_id &&
    expected.ownership_epoch === observed.ownership_epoch;
}

function scalarResourceTimeSource(
  sample: ReturnType<typeof resolveFooterScalarResourceSample>,
  selected: boolean,
): string {
  if (!selected || !sample) return "Live scalar sample";
  const attemptId = sample.series?.attempt_id;
  return attemptId
    ? `Accepted scalar observation · Attempt ${attemptId}`
    : "Accepted scalar observation";
}

function performanceFreshness(runtimePhase: {
  performanceStatus?: ResourceResult<RunPerformanceResource>["status"];
  performanceRefreshFailed?: boolean;
} | undefined): string {
  if (runtimePhase?.performanceRefreshFailed) return " · last observed; refresh unavailable";
  if (runtimePhase?.performanceStatus && runtimePhase.performanceStatus !== "ready") {
    return " · last observed; updating";
  }
  return "";
}

export type FooterTelemetryGroup = "runtime" | "solver" | "magnetization" | "energy";

function metricGroup(id: string): FooterTelemetryGroup {
  if (id.startsWith("energy-")) return "energy";
  if (id === "avg-mx" || id === "avg-my" || id === "avg-mz" || id === "avg-m") return "magnetization";
  if (id === "solver-progress" || id === "step" || id === "dt" || id === "active-solver" || id === "solver-error" || id === "solver-max-error" || id === "max-torque") return "solver";
  return "runtime";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
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

const SIMULATION_TIME_PREFIX_BY_EXPONENT: Readonly<Record<number, string>> = {
  [-15]: "f",
  [-12]: "p",
  [-9]: "n",
  [-6]: "µ",
  [-3]: "m",
  0: "",
  3: "k",
  6: "M",
  9: "G",
  12: "T",
};
const SIMULATION_TIME_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
  notation: "standard",
  useGrouping: false,
});

function formatFooterSimulationTime(seconds: number | null | undefined): {
  value: string;
  unit?: string;
} {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return { value: "—" };
  if (seconds === 0) return { value: "0", unit: "s" };

  const rawExponent = Math.floor(Math.log10(Math.abs(seconds)) / 3) * 3;
  let exponent = Math.max(-15, Math.min(12, rawExponent));
  let rounded = Number((seconds / 10 ** exponent).toPrecision(6));
  if (Math.abs(rounded) >= 1_000 && exponent < 12) {
    exponent += 3;
    rounded = Number((seconds / 10 ** exponent).toPrecision(6));
  }
  return {
    value: SIMULATION_TIME_NUMBER_FORMAT.format(rounded),
    unit: `${SIMULATION_TIME_PREFIX_BY_EXPONENT[exponent] ?? ""}s`,
  };
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
