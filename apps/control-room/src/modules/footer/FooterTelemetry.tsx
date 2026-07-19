"use client";

import {
  Clock3,
  FileText,
  Gauge,
  Hash,
  Magnet,
  Radio,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type {
  FrequencyDomainSweepProgressResource,
  LiveStatusResource,
  ObjectMetricsResource,
  SceneResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import {
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useObjectMetricsResource,
  useSolverStatusResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  formatRuntimeStateLabel,
  isRuntimeStateActive,
  isRuntimeStateWaitingForCompute,
  resolveEffectiveRuntimeState,
} from "@/kernel/runtime/runtimeStateDisplay";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { FullmagMark } from "@/shared/brand/FullmagLogo";
import { formatTorqueT } from "@/shared/domain/physics/torqueUnits";

const INTEGER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const COMPACT_DECIMAL_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 6,
});

type FooterLiveScalarSample = KernelEventMap["telemetry:scalar-sample"];

export function FooterTelemetry({
  bus,
}: {
  bus: EventBus<KernelEventMap>;
}) {
  const status = useSessionStatusSelector(selectFooterTelemetryStatus, {
    isEqual: footerTelemetryStatusEquals,
  });
  const liveSample = useFooterLiveScalarSample(bus);
  const scene = useSceneResource();
  const selectedObjectId = useSelectionSelector(
    (selection) => selection.objectId,
  );
  const objectId = useMemo(
    () => resolvePrimaryTelemetryObjectId(scene.data, selectedObjectId),
    [scene.data, selectedObjectId],
  );
  const objectMetrics = useObjectMetricsResource(objectId);
  const solverStatus = useSolverStatusResource({ enabled: Boolean(status) });
  const stageExecution = useStageExecutionResource({ enabled: Boolean(status) });
  const responseProgress = useFrequencyDomainResponseProgressResource({
    enabled: Boolean(status),
  });
  const responseSweep = useFrequencyDomainResponseSweepResource({
    enabled: Boolean(status),
  });
  const telemetry = buildFooterTelemetryModel(
    status,
    objectMetrics.data,
    solverStatus.data,
    liveSample,
    stageExecution.data,
    responseProgress.data,
    responseSweep.data,
  );

  return (
    <div className="fm-footer-telemetry" role="status" aria-label="Live telemetry">
      <div className="fm-footer-telemetry__brand">
        <FullmagMark size={24} className="fm-footer-telemetry__mark-wrapper" />
        <div className="fm-footer-telemetry__brand-copy">
          <span className="fm-footer-telemetry__brand-title">Fullmag</span>
          <span className="fm-footer-telemetry__brand-subtitle">
            Micromagnetics
          </span>
        </div>
      </div>

      <div className="fm-footer-telemetry__system">
        <StatusBadge
          detail={telemetry.statusDetail}
          state={telemetry.statusState}
          title={telemetry.statusTitle}
        />
        <div className="fm-footer-telemetry__online">
          <span className="fm-footer-telemetry__online-title">
            {telemetry.onlineTitle}
          </span>
          <span className="fm-footer-telemetry__online-detail">
            {telemetry.onlineDetail}
          </span>
        </div>
        {telemetry.frequencyDomainProgress ? (
          <FrequencyDomainProgress progress={telemetry.frequencyDomainProgress} />
        ) : null}
      </div>

      <div className="fm-footer-telemetry__metrics-grid" aria-label="Runtime metrics">
        {telemetry.metrics.map((metric) => (
          <TelemetryMetric key={metric.id} {...metric} />
        ))}
      </div>

      <div className="fm-footer-telemetry__links" aria-label="Footer links">
        <div className="fm-footer-telemetry__link-row">
          <span>Data Logs</span>
          <span>Reports</span>
          <span>API Docs</span>
          <span>Support</span>
        </div>
        <div className="fm-footer-telemetry__copyright">
          <FileText size={12} aria-hidden="true" />
          <span>© 2026 Fullmag.</span>
          <span>Designed by Mateusz Zelent.</span>
        </div>
      </div>
    </div>
  );
}

function useFooterLiveScalarSample(
  bus: EventBus<KernelEventMap>,
): FooterLiveScalarSample | null {
  const [sample, setSample] = useState<FooterLiveScalarSample | null>(null);

  useEffect(
    () => bus.on("telemetry:scalar-sample", (next) => setSample(next)),
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
};

type FooterTelemetryStatus = {
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
    "run_id" | "solver_steps" | "solver_time"
  > | null;
  sessionId: string;
  solver: Pick<
    LiveStatusResource["solver"],
    "converged" | "dt" | "max_torque_T" | "state"
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
          run_id: data.run.run_id,
          solver_steps: data.run.solver_steps,
          solver_time: data.run.solver_time,
        }
      : null,
    sessionId: data.session.session_id,
    solver: {
      converged: data.solver.converged ?? null,
      dt: data.solver.dt ?? null,
      max_torque_T: data.solver.max_torque_T ?? null,
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
    Object.is(previous.run?.run_id ?? null, next.run?.run_id ?? null) &&
    Object.is(
      previous.run?.solver_steps ?? null,
      next.run?.solver_steps ?? null,
    ) &&
    Object.is(
      previous.run?.solver_time ?? null,
      next.run?.solver_time ?? null,
    ) &&
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
) {
  const liveSampleForStatus = resolveLiveSampleForStatus(status, liveSample);
  const liveRow = liveSampleForStatus?.row ?? null;
  const runtimeState =
    resolveEffectiveRuntimeState({
      detailedRuntimeState: solverStatus?.runtime_state,
      sessionSolverState: status?.solver?.state,
    }) ?? "unknown";
  const runtimeStateLabel = formatRuntimeStateLabel(runtimeState);
  const simTimeSeconds =
    scalarSampleNumber(liveRow, "time") ??
    solverStatus?.sim_time_seconds ??
    status?.run?.solver_time ??
    0;
  const pseudoTimeSeconds =
    scalarSampleNumber(liveRow, "pseudo_time_s") ??
    solverStatus?.pseudo_time_seconds ??
    null;
  const activeRuntimeSeconds =
    scalarSampleNumber(liveRow, "active_runtime_s") ??
    objectNumber(solverStatus, "active_runtime_seconds") ??
    null;
  const usesPseudoTime = pseudoTimeSeconds !== null;
  const primaryTimeSeconds = usesPseudoTime ? pseudoTimeSeconds : simTimeSeconds;
  const totalSteps =
    scalarSampleNumber(liveRow, "step") ??
    solverStatus?.step_index ??
    status?.run?.solver_steps ??
    status?.metrics?.total_steps ??
    0;
  const stepsPerSecond = status?.metrics?.steps_per_second;
  const maxTorqueT =
    scalarSampleNumber(liveRow, "max_torque_T") ??
    solverStatus?.max_torque_T ??
    status?.solver?.max_torque_T;
  const dt =
    scalarSampleNumber(liveRow, "solver_dt") ??
    scalarSampleNumber(liveRow, "dt") ??
    solverStatus?.dt_seconds ??
    status?.solver?.dt;
  const errorEstimate =
    scalarSampleNumber(liveRow, "error_estimate") ?? solverStatus?.error_estimate ?? null;
  const maxError = scalarSampleNumber(liveRow, "max_error") ?? solverStatus?.max_error ?? null;
  const dtSuggested =
    scalarSampleNumber(liveRow, "dt_suggested") ?? solverStatus?.dt_suggested_seconds ?? null;
  const rejectedAttempts =
    scalarSampleNumber(liveRow, "rejected_attempts") ?? solverStatus?.rejected_attempts ?? 0;
  const converged = solverStatus?.converged ?? status?.solver?.converged;
  const scalarEnergy = {
    anisotropy: scalarSampleNumber(liveRow, "e_ani"),
    demag: scalarSampleNumber(liveRow, "e_demag"),
    dmi: scalarSampleNumber(liveRow, "e_dmi"),
    exchange: scalarSampleNumber(liveRow, "e_ex"),
    total: scalarSampleNumber(liveRow, "e_total"),
    zeeman: scalarSampleNumber(liveRow, "e_ext"),
  };
  const totalEnergy =
    scalarEnergy.total ?? objectMetrics?.energies.total ?? status?.energies?.total;
  const scalarMagnetization = scalarSampleMagnetization(liveRow);
  const magnetization = scalarMagnetization ?? objectMetrics?.magnetization_average;
  const magnetizationMagnitude = magnetization
    ? Math.hypot(magnetization.mx, magnetization.my, magnetization.mz)
    : null;
  const statusTitle = `System Status: ${runtimeStateLabel}`;
  const active = isRuntimeStateActive(runtimeState);
  const waitingForCompute = isRuntimeStateWaitingForCompute(runtimeState);
  const liveSampleSource = liveRow ? "Live scalar sample" : null;
  const magnetizationSource =
    liveSampleSource ?? objectMetrics?.source ?? "No object sample";
  const energySource = liveSampleSource
    ? liveSampleSource
    : objectMetrics
      ? `Object: ${objectMetrics.object_id}`
      : "Session summary";
  const timeSource = liveRow
    ? `Scalar rev ${String(liveSampleForStatus?.revision ?? "")}`
    : solverStatus
      ? "Last sync: solver status"
      : status
        ? "Last sync: status"
        : "Last sync: pending";
  const frequencyDomainProgress = buildFrequencyDomainProgress({
    responseProgress,
    responseSweep,
    solverStageKind: solverStatus?.stage_kind,
    stageExecution,
  });

  return {
    frequencyDomainProgress,
    metrics: [
      {
        detail: usesPseudoTime
          ? "Direct minimizer pseudotime"
          : "Physical simulation time",
        icon: <Clock3 size={13} aria-hidden="true" />,
        id: "time",
        label: usesPseudoTime ? "Pseudo time" : "Sim time",
        subdetail: timeSource,
        value: formatDuration(primaryTimeSeconds),
      },
      ...(usesPseudoTime
        ? [
            {
              detail: "Physical simulation time",
              icon: <Clock3 size={13} aria-hidden="true" />,
              id: "sim-time",
              label: "Sim time",
              subdetail: timeSource,
              value: formatDuration(simTimeSeconds),
            },
          ]
        : []),
      ...(activeRuntimeSeconds !== null
        ? [
            {
              detail: "Active compute time",
              icon: <Clock3 size={13} aria-hidden="true" />,
              id: "active-runtime",
              label: "Runtime",
              subdetail: timeSource,
              value: formatDuration(activeRuntimeSeconds),
            },
          ]
        : []),
      {
        detail: "Throughput",
        icon: <Radio size={13} aria-hidden="true" />,
        id: "steps-per-second",
        label: "Steps/s",
        subdetail: `${formatInteger(totalSteps)} steps`,
        value: formatFixed(stepsPerSecond, 1, "0.0"),
      },
      {
        detail: "Latest step",
        icon: <Hash size={13} aria-hidden="true" />,
        id: "step",
        label: "Step",
        subdetail: `t=${formatScientific(
          liveRow
            ? simTimeSeconds
            : objectMetrics?.time_seconds ?? simTimeSeconds,
          "0.000000e+0",
        )} s`,
        value: formatInteger(
          liveRow ? totalSteps : objectMetrics?.step ?? totalSteps,
        ),
      },
      {
        detail: usesPseudoTime ? "Minimizer pseudotime step" : "Solver timestep",
        icon: <Clock3 size={13} aria-hidden="true" />,
        id: "dt",
        label: usesPseudoTime ? "Pseudo dt" : "dt",
        subdetail: `State: ${runtimeStateLabel}`,
        unit: "s",
        value: formatScientific(dt, "0.000000e+0"),
      },
      ...(!usesPseudoTime && (errorEstimate !== null || maxError !== null)
        ? [
            {
              detail: "Latest embedded vector error",
              icon: <Gauge size={13} aria-hidden="true" />,
              id: "solver-error",
              label: "Error",
              subdetail: `${formatInteger(rejectedAttempts)} rejected; next dt ${formatScientific(dtSuggested, "0.000000e+0")} s`,
              value: formatScientific(errorEstimate, "0.000000e+0"),
            },
            {
              detail: "Adaptive acceptance threshold",
              icon: <Gauge size={13} aria-hidden="true" />,
              id: "solver-max-error",
              label: "MaxError",
              subdetail: errorEstimate !== null && maxError !== null
                ? errorEstimate <= maxError ? "Within tolerance" : "Above tolerance"
                : "Tolerance status unavailable",
              value: formatScientific(maxError, "0.000000e+0"),
            },
          ]
        : []),
      {
        detail: "Peak Load",
        icon: <Gauge size={13} aria-hidden="true" />,
        id: "max-torque",
        label: "Max Torque",
        subdetail: `Converged: ${formatBoolean(converged)}`,
        value: formatTorqueTelemetry(maxTorqueT),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-mx",
        label: "avg mx",
        subdetail: magnetizationSource,
        value: formatFixed(magnetization?.mx, 6, "0.000000"),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-my",
        label: "avg my",
        subdetail: magnetizationSource,
        value: formatFixed(magnetization?.my, 6, "0.000000"),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-mz",
        label: "avg mz",
        subdetail: magnetizationSource,
        value: formatFixed(magnetization?.mz, 6, "0.000000"),
      },
      {
        detail: "Average magnetization",
        icon: <Magnet size={13} aria-hidden="true" />,
        id: "avg-m",
        label: "|avg m|",
        subdetail: liveRow
          ? "Live scalar sample"
          : objectMetrics?.has_solver_sample
            ? "Solver sample"
            : "Initial state",
        value: formatFixed(magnetizationMagnitude, 6, "0.000000"),
      },
      {
        detail: "Total",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-total",
        label: "Energy",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(totalEnergy, "0.000000e+0"),
      },
      {
        detail: "Exchange",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-exchange",
        label: "Exchange",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(
          scalarEnergy.exchange ??
            objectMetrics?.energies.exchange ??
            status?.energies?.exchange,
          "0.000000e+0",
        ),
      },
      {
        detail: "Demag",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-demag",
        label: "Demag",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(
          scalarEnergy.demag ??
            objectMetrics?.energies.demag ??
            status?.energies?.demag,
          "0.000000e+0",
        ),
      },
      {
        detail: "Zeeman",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-zeeman",
        label: "Zeeman",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(
          scalarEnergy.zeeman ??
            objectMetrics?.energies.zeeman ??
            status?.energies?.zeeman,
          "0.000000e+0",
        ),
      },
      {
        detail: "Anisotropy",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-anisotropy",
        label: "Anisotropy",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(
          scalarEnergy.anisotropy ??
            objectMetrics?.energies.anisotropy ??
            status?.energies?.anisotropy,
          "0.000000e+0",
        ),
      },
      {
        detail: "DMI",
        icon: <Zap size={13} aria-hidden="true" />,
        id: "energy-dmi",
        label: "DMI",
        subdetail: energySource,
        unit: "J",
        value: formatScientific(
          scalarEnergy.dmi ??
            objectMetrics?.energies.dmi ??
            status?.energies?.dmi,
          "0.000000e+0",
        ),
      },
    ] satisfies FooterTelemetryMetric[],
    onlineDetail: status ? "Live session channel" : "Awaiting session",
    onlineTitle: waitingForCompute
      ? "Online / Waiting"
      : active
        ? "Online / Active"
        : "Local / Standby",
    statusDetail: status ? "Runtime telemetry" : "Waiting for runtime",
    statusState: runtimeState,
    statusTitle,
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

function FrequencyDomainProgress({
  progress,
}: {
  progress: FooterFrequencyDomainProgress;
}) {
  const width = progress.percent ?? 100;
  return (
    <div className="fm-footer-telemetry__frequency-progress">
      <div className="fm-footer-telemetry__frequency-progress-header">
        <span>{progress.title}</span>
        <span>{progress.percentLabel}</span>
      </div>
      <div className="fm-footer-telemetry__frequency-progress-chips">
        {[
          progress.solutionLabel ?? progress.pointLabel,
          progress.frequencyLabel,
          progress.solveLabel,
          progress.modeLabel,
          progress.solverLabel,
          progress.residualLabel,
          progress.rangeLabel,
        ]
          .filter((label): label is string => Boolean(label))
          .map((label) => (
            <span key={label}>{label}</span>
          ))}
      </div>
      <div
        aria-label={progress.title}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.percent ?? undefined}
        className={
          progress.percent === null
            ? "fm-footer-telemetry__frequency-progress-track fm-footer-telemetry__frequency-progress-track--indeterminate"
            : "fm-footer-telemetry__frequency-progress-track"
        }
        role="progressbar"
      >
        <span
          className="fm-footer-telemetry__frequency-progress-bar"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="fm-footer-telemetry__frequency-progress-detail">
        {progress.detail}
      </span>
    </div>
  );
}

function resolveLiveSampleForStatus(
  status: FooterTelemetryStatus | null | undefined,
  liveSample: FooterLiveScalarSample | null | undefined,
): FooterLiveScalarSample | null {
  if (!liveSample) return null;
  if (status?.sessionId && liveSample.sessionId !== status.sessionId) return null;
  const runId = status?.run?.run_id ?? null;
  if (runId && liveSample.runId !== runId) return null;
  return liveSample;
}

export function resolvePrimaryTelemetryObjectId(
  scene: SceneResource | null | undefined,
  selectedObjectId?: string | null,
): string | null {
  const sceneRecord = asRecord(scene);
  const objects = sceneRecord?.objects;
  if (!Array.isArray(objects)) return null;

  if (selectedObjectId) {
    for (const object of objects) {
      if (asString(asRecord(object)?.id) === selectedObjectId) {
        return selectedObjectId;
      }
    }
  }

  for (const object of objects) {
    const objectId = asString(asRecord(object)?.id);
    if (objectId) return objectId;
  }

  return null;
}

function StatusBadge({
  detail,
  state,
  title,
}: {
  detail: string;
  state: string;
  title: string;
}) {
  return (
    <div className="fm-footer-telemetry__badge" data-state={state}>
      <span className="fm-footer-telemetry__badge-dot" aria-hidden="true" />
      <span className="fm-footer-telemetry__badge-copy">
        <span className="fm-footer-telemetry__badge-label">{title}</span>
        <span className="fm-footer-telemetry__badge-detail">{detail}</span>
      </span>
    </div>
  );
}

function TelemetryMetric({
  detail,
  icon,
  label,
  subdetail,
  unit,
  value,
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  subdetail: string;
  unit?: string;
  value: string;
}) {
  return (
    <div className="fm-footer-telemetry__metric">
      <div className="fm-footer-telemetry__metric-label">
        {icon}
        <span>{label}</span>
      </div>
      <div className="fm-footer-telemetry__metric-value">
        <span>{value}</span>
        {unit ? (
          <span className="fm-footer-telemetry__metric-unit">{unit}</span>
        ) : null}
      </div>
      <div className="fm-footer-telemetry__metric-detail">
        <span>{detail}</span>
        <span>{subdetail}</span>
      </div>
    </div>
  );
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
  const totalSeconds = Math.max(
    0,
    Math.floor(
      typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0,
    ),
  );
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(remainingSeconds).padStart(2, "0")}s`;
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
    : "0";
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
    : "0.000000e+0 T";
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
