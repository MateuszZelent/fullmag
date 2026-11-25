"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { CurrentRunResource, RunPerformanceResource, ScalarWindowResource, StageExecutionResource } from "@/kernel/api/apiTypes";
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
import { resolveRuntimeUserSolvePhase } from "@/kernel/runtime/runtimeStateDisplay";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { Progress } from "@/shared/ui/Progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/Tooltip";

import { AuthoredAntennaTelemetry } from "./AuthoredAntennaTelemetry";
import {
  formatAntennaFieldEta,
  useAntennaFieldEta,
  type AntennaFieldEta,
} from "./antennaFieldEta";

import { type FooterTelemetryStatus, resolveFooterSolverStatus, resolveFooterAntennaStage, resolveFooterEigensolveStage, resolvePrimaryTelemetryObjectId, resolveFooterMagneticModelPresent } from "./FooterTelemetry.model";
import { readAntennaProgress, buildFooterTelemetryModel, type FooterLiveScalarSample, type FooterAntennaProgress, isFrequencyResponseStageKind, type FooterFrequencyDomainProgress, type FooterTelemetryGroup, type FooterTelemetryMetric } from "./FooterTelemetry.presentation";
import { resolveFooterPerformanceProgressFraction } from "./footerPerformanceProgress";
import { resolveFooterStageSelection, resolveFooterStepCounters, type FooterStageSelection } from "./footerStepCounters";

const FOOTER_SCALAR_COLUMNS = ["step", "time", "dt", "pseudo_time_s", "mx", "my", "mz", "e_total"] as const;
const FOOTER_HISTORY_COLUMNS = ["step", "time", "pseudo_time_s", "e_total", "max_torque_T"] as const;
const HISTORY_LIMIT = 120;
const FOOTER_INTEGER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

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
  view: "overview" | "antenna" | "eigensolve";
}) {
  const solverStatus = useSolverStatusResource({
    enabled: Boolean(status) && (view === "overview" || view === "eigensolve"),
  });
  const solverStatusForRun = resolveFooterSolverStatus(status, solverStatus.data);
  const currentSolverIntegrator = solverStatusForRun?.integrator?.trim() || null;
  const observedStageIndex = status?.run?.stage_index;
  const currentStageIndex = typeof observedStageIndex === "number" && Number.isSafeInteger(observedStageIndex)
    ? observedStageIndex
    : null;
  const [lastKnownIntegrator, setLastKnownIntegrator] = useState<{
    runId: string;
    stageIndex: number | null;
    value: string;
  } | null>(null);
  const currentRunId = status?.run?.run_id ?? null;
  if (currentRunId && currentSolverIntegrator &&
      (lastKnownIntegrator?.runId !== currentRunId ||
        lastKnownIntegrator.stageIndex !== currentStageIndex ||
        lastKnownIntegrator.value !== currentSolverIntegrator)) {
    setLastKnownIntegrator({
      runId: currentRunId,
      stageIndex: currentStageIndex,
      value: currentSolverIntegrator,
    });
  }
  const runtimeIntegrator = currentSolverIntegrator ??
    (lastKnownIntegrator && lastKnownIntegrator.runId === currentRunId &&
      lastKnownIntegrator.stageIndex === currentStageIndex
      ? lastKnownIntegrator.value
      : null);
  const antennaStage = resolveFooterAntennaStage(status, stageExecution.data);
  const eigensolveStage = resolveFooterEigensolveStage(status, stageExecution.data);
  const antennaNumerical = antennaStage ? readAntennaProgress(antennaStage.record) : null;
  const stageClockKey =
    view === "antenna"
      ? !antennaNumerical
        ? antennaStage?.clockKey ?? null
        : null
      : view === "eigensolve"
        ? eigensolveStage?.clockKey ?? null
        : null;
  const stageNowMs = useAntennaStageClock(stageClockKey);
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
  const runId = status?.run?.run_id ?? null;
  const sessionEpoch = status?.sessionEpoch ?? null;
  const historyWindow = useScalarWindowResource({
    columns: FOOTER_HISTORY_COLUMNS,
    enabled: generalTelemetryEnabled && runId !== null,
    limit: HISTORY_LIMIT,
    tail: true,
  });
  const acceptedHistory = useMemo(
    () => resolveAcceptedFooterHistory(historyWindow.data, runId, sessionEpoch),
    [historyWindow.data, runId, sessionEpoch],
  );
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
    (generalTelemetryEnabled || (Boolean(status) && view === "eigensolve")) &&
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
  const stageSelection = resolveFooterStageSelection(status, stageExecution.data);
  const stageHandoff = Boolean(
    stageSelection?.execution && stageSelection.runActive && stageSelection.activeStageIndex === null,
  );
  const stageProgress = resolveFooterStageProgress(
    stageSelection, status, stageHandoff ? null : performance.data,
    stageHandoff ? null : scalarWindow.data?.series,
  );
  const stepCounters = resolveFooterStepCounters(
    status, stageExecution.data, performance.data, scalarWindow.data, performance.status, stageSelection,
  );
  const telemetry = buildFooterTelemetryModel(
    status,
    objectId && objectMetrics.data?.object_id === objectId ? objectMetrics.data : null,
    solverStatusForRun,
    stageHandoff ? null : liveSample,
    stageExecution.data,
    responseProgress.data,
    responseSweep.data,
    stageHandoff ? null : scalarWindow.data,
    {
      magneticModelPresent: resolveFooterMagneticModelPresent(scene),
      performance: stageHandoff ? null : performance.data,
      performanceStatus: performance.status,
      performanceRefreshFailed: Boolean(performance.error || performance.refreshError),
      currentRunStatus: currentRunForStatus?.status,
      scalarHistory: historyWindow.data,
      runtimeIntegrator,
      nowMs: stageNowMs,
      stageExecutionUnpublished,
      stageHandoff,
      stageProgressAvailable: stageProgress?.percent !== null && stageProgress !== null,
      stageReference: stageProgress?.active && stageProgress.stageIndex !== null
        ? { stageIndex: stageProgress.stageIndex, stageId: stageProgress.stageId }
        : null,
      telemetryView: view,
      userSolvePhase,
    },
  );
  const stepCounterMetrics = useMemo<FooterTelemetryMetric[]>(() => {
    if (!status) return [];
    const attempt = stepCounters.activeAttemptId
      ? ` · ${stepCounters.activeStepSource === "sample" ? "sample" : "solver"} attempt ${stepCounters.activeAttemptId}`
      : "";
    const stageContext = stepCounters.activeStageIndex === null
      ? stepCounters.handoff
        ? `Between stages ${stepCounters.handoff.fromStageIndex + 1} and ${stepCounters.handoff.toStageIndex + 1}`
        : "No active stage step counter"
      : `Stage ${stepCounters.activeStageIndex + 1}${attempt}`;
    const missingStages = stepCounters.missingStageIndexes.length > 0
      ? `Missing stage counters: ${stepCounters.missingStageIndexes.map((index) => index + 1).join(", ")}`
      : "";
    const runValue = stepCounters.runSteps === null
      ? "—"
      : `${stepCounters.runStepsExact ? "" : "≥"}${FOOTER_INTEGER_FORMAT.format(stepCounters.runSteps)}`;
    return [
      {
        detail: stepCounters.activeStepSource === "solver"
          ? "Current stage-local step from the matching run, stage, and solver attempt."
          : stepCounters.activeStepSource === "sample"
            ? "Current stage-local step from the accepted scalar observation and its attempt identity."
            : "No current stage-local step is verified.",
        icon: <span aria-hidden="true">#</span>,
        id: "stage-steps",
        label: "Stage steps",
        subdetail: stageContext,
        unit: "steps",
        value: stepCounters.stageSteps === null
          ? "—"
          : FOOTER_INTEGER_FORMAT.format(stepCounters.stageSteps),
      },
      {
        detail: stepCounters.runStepsExact
          ? "Sum of published completed-stage counts and the current stage-local count."
          : missingStages || "Known subtotal only; one or more stage counters are unavailable.",
        icon: <span aria-hidden="true">#</span>,
        id: "run-steps",
        label: "Run steps",
        subdetail: missingStages || (stepCounters.handoff
          ? `Stage handoff · ${stepCounters.handoff.fromStageIndex + 1} → ${stepCounters.handoff.toStageIndex + 1}`
          : stepCounters.runStepsExact ? "Complete published count" : "Incomplete published count"),
        unit: "steps",
        value: runValue,
      },
    ];
  }, [status, stepCounters]);
  const displayMetrics = useMemo(
    () => [...telemetry.metrics, ...stepCounterMetrics],
    [stepCounterMetrics, telemetry.metrics],
  );
  const legacyHistory = useTelemetryHistory(
    acceptedHistory ? null : runId,
    acceptedHistory ? null : telemetry.metrics.find((metric) => metric.id === "time")?.numeric ?? null,
    telemetry.metrics.find((metric) => metric.id === "energy-total")?.numeric ?? null,
    telemetry.metrics.find((metric) => metric.id === "max-torque")?.numeric ?? null,
  );
  const history = acceptedHistory ?? legacyHistory;

  if (view === "antenna" && !antennaStage) {
    return (
      <AuthoredAntennaTelemetry
        scene={scene.data}
        sceneStatus={scene.status}
        hasRun={status ? Boolean(status.run?.run_id) : null}
      />
    );
  }
  if (view === "eigensolve" && !eigensolveStage) {
    return (
      <div className="fm-footer-telemetry__empty" role="region" aria-label="Eigensolve telemetry">
        <strong>No eigensolve stage in the current execution</strong>
        <span>Run a Study containing an Eigenmodes or Frequency Response stage to inspect modal solver counters, residuals, and publication.</span>
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
    <div
      className="fm-footer-telemetry"
      role="region"
      aria-label={
        view === "antenna"
          ? "Antenna telemetry"
          : view === "eigensolve"
            ? "Eigensolve telemetry"
            : "Simulation telemetry"
      }
    >
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
            <TelemetryBoard history={history} metrics={displayMetrics} stage={stageProgress} />
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

const FOOTER_TELEMETRY_GROUP_LABELS: Record<FooterTelemetryGroup, string> = {
  runtime: "Runtime",
  solver: "Solver",
  magnetization: "Magnetization",
  energy: "Energy",
};

/**
 * One readout: label and value only. Provenance and method notes live in a
 * contextual tooltip (hover or keyboard focus) so the dock stays one or two
 * rows tall instead of growing with expandable descriptions.
 */
function TelemetryMetric({
  ariaLabel,
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
  label: ReactNode;
  /** Plain-text label for assistive technology when `label` is a symbol. */
  ariaLabel?: string;
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
          aria-label={`${ariaLabel ?? String(label)}: ${reading}`}
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

/* -- Telemetry board (mockup dock) --
 * Run: simulated time as the hero reading with the active stage and its
 * runtime-reported progress. Magnetization: diverging bars for <m>.
 * Solver and Energy: readouts with sparklines of samples observed in this
 * run. Nothing is illustrative: absent data leaves the visual out. */

type FooterStageProgress = {
  active: boolean;
  badgeLabel: string;
  handoffLabel: string | null;
  index: number | null;
  label: string | null;
  percent: number | null;
  runActive: boolean;
  stageId: string | null;
  stageIndex: number | null;
  total: number | null;
};

function resolveFooterStageProgress(
  selection: FooterStageSelection | null,
  status: FooterTelemetryStatus | null,
  performance?: RunPerformanceResource | null,
  scalarSeries?: ScalarWindowResource["series"] | null,
): FooterStageProgress | null {
  if (!selection || (selection.terminal && selection.activeStageIndex === null)) return null;
  const total = selection.totalStages;
  const run = status?.run;
  if (!run?.run_id || total === null) return null;

  if (selection.activeStageIndex !== null) {
    const record = selection.activeStage;
    const stageIndex = selection.activeStageIndex;
    const stageId = selection.activeStageId;
    const performanceFraction = resolveFooterPerformanceProgressFraction(
      run.run_id, performance, { stageIndex, stageId }, scalarSeries,
    );
    const recordPercent = typeof record?.progress_percent === "number" &&
        Number.isFinite(record.progress_percent)
      ? Math.min(100, Math.max(0, record.progress_percent))
      : null;
    const percent = recordPercent ?? (performanceFraction === null ? null : performanceFraction * 100);
    if (selection.terminal && selection.execution === null && percent === null) return null;
    return {
      active: true,
      badgeLabel: `Stage ${stageIndex + 1}/${total}`,
      handoffLabel: null,
      index: stageIndex + 1,
      label: record?.progress_label ?? record?.label ?? record?.kind ?? (run.stage_label.trim() || null),
      percent,
      runActive: selection.runActive,
      stageId,
      stageIndex,
      total,
    };
  }

  if (selection.handoff) {
    const from = selection.handoff.fromStageIndex + 1;
    const to = selection.handoff.toStageIndex + 1;
    return {
      active: false,
      badgeLabel: `Stage ${from} → ${to}`,
      handoffLabel: `Between stages ${from} and ${to}`,
      index: null,
      label: null,
      percent: null,
      runActive: true,
      stageId: null,
      stageIndex: null,
      total,
    };
  }

  if (selection.runActive && selection.execution) {
    return {
      active: false,
      badgeLabel: "Run active",
      handoffLabel: "Current stage is not published",
      index: null,
      label: null,
      percent: null,
      runActive: true,
      stageId: null,
      stageIndex: null,
      total,
    };
  }
  return null;
}

type TelemetryHistory = { energy: readonly number[]; torque: readonly number[] };
const EMPTY_HISTORY: TelemetryHistory = { energy: [], torque: [] };

function resolveAcceptedFooterHistory(
  window: ScalarWindowResource | null | undefined,
  runId: string | null,
  sessionEpoch: string | null,
): TelemetryHistory | null {
  if (!runId || !sessionEpoch || window?.series?.run_id !== runId) return null;

  const stepColumn = window.columns.indexOf("step");
  const energyColumn = window.columns.indexOf("e_total");
  const torqueColumn = window.columns.indexOf("max_torque_T");
  if (stepColumn < 0 || window.rows.length !== window.observation_frames.length) return EMPTY_HISTORY;

  const energy: number[] = [];
  const torque: number[] = [];
  for (const [index, row] of window.rows.entries()) {
    const frame = window.observation_frames[index];
    const step = row[stepColumn];
    if (frame.session_epoch !== sessionEpoch || frame.source_step !== step || !Number.isSafeInteger(step) || step < 0) {
      continue;
    }
    const total = row[energyColumn];
    const maxTorque = row[torqueColumn];
    if (Number.isFinite(total)) energy.push(total);
    if (Number.isFinite(maxTorque)) torque.push(maxTorque);
  }
  return { energy, torque };
}

/** Keeps the readings observed in the current run, one point per new sim time. */
function appendTelemetryHistory(
  series: readonly number[],
  value: number | null,
): readonly number[] {
  return value === null ? series : [...series, value].slice(-HISTORY_LIMIT);
}

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
    setState(simTime === null || simTime === base.time ? base : {
      runId,
      time: simTime,
      history: {
        energy: appendTelemetryHistory(base.history.energy, energy),
        torque: appendTelemetryHistory(base.history.torque, torque),
      },
    });
  }
  return state.runId === runId ? state.history : EMPTY_HISTORY;
}

function TelemetrySparkline({ label, log = false, values }: { label: string; log?: boolean; values: readonly number[] }) {
  const points = log ? values.flatMap((value) => value > 0 ? [Math.log10(value)] : []) : values;
  if (points.length < 2) {
    // The chart keeps its frame before the run publishes samples; no data is invented.
    return (
      <span className="fm-footer-telemetry__spark-frame" data-empty="true">
        <svg aria-hidden="true" className="fm-footer-telemetry__spark" preserveAspectRatio="none" viewBox="0 0 100 30">
          <path className="fm-footer-telemetry__spark-grid" d="M0,8 L100,8 M0,16 L100,16 M0,24 L100,24" vectorEffect="non-scaling-stroke" />
          <path className="fm-footer-telemetry__spark-baseline" d="M0,28 L100,28" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="fm-footer-telemetry__spark-empty">{label}: no samples yet</span>
      </span>
    );
  }
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const path = points
    .map((value, index) => `${index ? "L" : "M"}${((index / (points.length - 1)) * 100).toFixed(2)},${(28 - ((value - min) / span) * 26).toFixed(2)}`)
    .join(" ");
  return (
    <span className="fm-footer-telemetry__spark-frame">
      <svg aria-label={label} className="fm-footer-telemetry__spark" preserveAspectRatio="none" role="img" viewBox="0 0 100 30">
        <path className="fm-footer-telemetry__spark-grid" d="M0,8 L100,8 M0,16 L100,16 M0,24 L100,24" vectorEffect="non-scaling-stroke" />
        <path className="fm-footer-telemetry__spark-area" d={`${path} L100,30 L0,30 Z`} />
        <path className="fm-footer-telemetry__spark-line" d={path} vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
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

type BoardCard = "run" | "magnetization" | "energy" | "convergence";

/** Mockup cards and the metrics each one shows, in reading order. */
const BOARD_CARDS: ReadonlyArray<{ id: BoardCard; title: string; group: FooterTelemetryGroup; metricIds: readonly string[] }> = [
  { id: "run", title: "Run", group: "runtime", metricIds: ["stage-steps", "run-steps", "solver-progress", "step", "dt", "rate", "stage-rate", "active-solver", "sim-time", "active-runtime"] },
  { id: "magnetization", title: "Magnetization", group: "magnetization", metricIds: ["avg-mx", "avg-my", "avg-mz", "avg-m"] },
  { id: "energy", title: "Energy", group: "energy", metricIds: ["energy-exchange", "energy-demag", "energy-zeeman", "energy-anisotropy", "energy-dmi"] },
  { id: "convergence", title: "Convergence", group: "solver", metricIds: ["solver-error", "solver-max-error"] },
];

const AXIS_SYMBOLS: Record<string, ReactNode> = {
  "avg-mx": <>⟨m<sub>x</sub>⟩</>,
  "avg-my": <>⟨m<sub>y</sub>⟩</>,
  "avg-mz": <>⟨m<sub>z</sub>⟩</>,
};

const telemetryMetricRow = (metric: FooterTelemetryMetric, group: FooterTelemetryGroup) => (
  <TelemetryMetric
    key={metric.id}
    detail={metric.detail}
    group={group}
    label={AXIS_SYMBOLS[metric.id] ? <span className="fm-footer-telemetry__symbol">{AXIS_SYMBOLS[metric.id]}</span> : metric.label}
    ariaLabel={metric.label}
    subdetail={metric.subdetail}
    unit={metric.unit}
    value={metric.value}
    visual={AXIS_SYMBOLS[metric.id] ? <DivergingBar value={metric.numeric} /> : undefined}
  />
);

function TelemetryBoard({
  history,
  metrics,
  stage,
}: {
  history: TelemetryHistory;
  metrics: readonly FooterTelemetryMetric[];
  stage: FooterStageProgress | null;
}) {
  const byId = new Map(metrics.map((metric) => [metric.id, metric]));
  const time = byId.get("time");
  const total = byId.get("energy-total");
  const torque = byId.get("max-torque");
  return (
    <>
      {BOARD_CARDS.map((card) => {
        const rows = card.metricIds.flatMap((id) => {
          const metric = byId.get(id);
          return metric ? [metric] : [];
        });
        return (
          <section
            aria-label={`${card.title} metrics`}
            className="fm-footer-telemetry__group"
            data-card={card.id}
            data-group={card.group}
            key={card.id}
          >
            <header className="fm-footer-telemetry__group-head">
              <h3 className="fm-footer-telemetry__group-title">{card.title}</h3>
              {card.id === "run" ? (
                <span className="fm-footer-telemetry__stage-badge" data-idle={stage?.active ? undefined : "true"}>
                  {stage?.badgeLabel ?? "No active run"}
                </span>
              ) : null}
              {card.id === "magnetization" ? <span className="fm-footer-telemetry__group-aside">mean over magnets</span> : null}
              {card.id === "energy" ? <span className="fm-footer-telemetry__group-aside">total, J</span> : null}
              {card.id === "convergence" && torque ? (
                <span className="fm-footer-telemetry__group-aside fm-footer-telemetry__group-aside--value" title={torque.detail}>
                  {torque.value}{torque.unit ? ` ${torque.unit}` : ""}
                </span>
              ) : null}
            </header>
            {card.id === "run" && time ? (
              <div className="fm-footer-telemetry__hero" title={time.detail}>
                <span className="fm-footer-telemetry__hero-value">{time.value}</span>
                <span className="fm-footer-telemetry__hero-unit">{time.unit ? `${time.unit} ` : ""}{time.label.toLowerCase()}</span>
              </div>
            ) : null}
            {card.id === "run" ? (
              <div className="fm-footer-telemetry__stage-progress" data-idle={stage?.percent == null ? "true" : undefined}>
                {stage?.active ? (
                  <>
                    <Progress
                      aria-label={`Stage ${stage.index} of ${stage.total} progress`}
                      className="fm-footer-telemetry__stage-bar"
                      value={stage.percent}
                    />
                    <span className="fm-footer-telemetry__stage-label">
                      {stage.percent !== null
                        ? `${stage.label ? `${stage.label} · ` : ""}${Math.round(stage.percent)}%`
                        : `${stage.label ?? "Active stage"} · progress not published`}
                    </span>
                  </>
                ) : (
                  <span className="fm-footer-telemetry__stage-label">
                    {stage?.handoffLabel ?? (stage?.runActive ? "Stage transition in progress" : "Starts when Compute runs")}
                  </span>
                )}
              </div>
            ) : null}
            {card.id === "energy" ? (
              <div className="fm-footer-telemetry__energy">
                <div className="fm-footer-telemetry__rows">{rows.map((metric) => telemetryMetricRow(metric, card.group))}</div>
                <div className="fm-footer-telemetry__energy-total">
                  <span className="fm-footer-telemetry__energy-value" title={total?.detail}>{total?.value ?? "—"}</span>
                  <TelemetrySparkline label="Total energy" values={history.energy} />
                  <span className="fm-footer-telemetry__caption">E<sub>total</sub>, this run</span>
                </div>
              </div>
            ) : card.id === "convergence" ? (
              <>
                <TelemetrySparkline label="Max torque" log values={history.torque} />
                <span className="fm-footer-telemetry__caption fm-footer-telemetry__caption--split">
                  <span>max |m × H<sub>eff</sub>|</span>
                  <span>log scale, this run</span>
                </span>
                {rows.length > 0 ? <div className="fm-footer-telemetry__rows">{rows.map((metric) => telemetryMetricRow(metric, card.group))}</div> : null}
              </>
            ) : (
              <div className="fm-footer-telemetry__rows" data-columns={card.id === "run" ? 2 : 1}>
                {rows.map((metric) => telemetryMetricRow(metric, card.group))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
