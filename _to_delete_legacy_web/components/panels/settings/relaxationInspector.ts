"use client";

import type { LiveState, ScalarRow, StageExecutionRecord, StageStopReason } from "@/lib/session/types";

type Tone = "default" | "accent" | "info" | "warn" | "danger";

export interface RelaxationProgressMetric {
  key: "torque" | "energy" | "max_steps" | "max_pseudotime" | "max_physical_time";
  label: string;
  value: string;
  detail: string;
  progress: number | null;
  tone: Tone;
}

export interface RelaxationInspectorState {
  overviewLabel: string;
  overviewValue: string;
  overviewDetail: string;
  overviewAuxValue: string | null;
  overviewProgress: number | null;
  overviewTone: Tone;
  semantics: string;
  lastStopLabel: string;
  lastStopDetail: string;
  metrics: RelaxationProgressMetric[];
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  const parsed = parseOptionalNumber(value);
  if (parsed == null || parsed < 1) return null;
  return Math.trunc(parsed);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function lowerIsBetterProgress(current: number | null, threshold: number): number | null {
  if (current == null || !Number.isFinite(current)) return null;
  if (current <= threshold) return 100;
  if (current <= 0) return threshold > 0 ? 100 : 0;
  return clampPercent((threshold / current) * 100);
}

function upperBudgetProgress(current: number | null, threshold: number): number | null {
  if (current == null || !Number.isFinite(current)) return null;
  return clampPercent((current / threshold) * 100);
}

function formatCompact(value: number | null, unit = ""): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toExponential(3)}${unit}`;
}

function stopReasonLabel(reason: StageStopReason | null): string {
  switch (reason) {
    case "torque":
      return "Stopped by torque threshold";
    case "energy":
      return "Stopped by energy delta threshold";
    case "max_steps":
      return "Stopped by max steps budget";
    case "max_pseudotime":
      return "Stopped by max pseudotime budget";
    case "max_physical_time":
      return "Stopped by max physical time budget";
    case "user_cancelled":
      return "Stopped by user";
    case "backend_error":
      return "Stopped by backend error";
    default:
      return "Stop reason pending";
  }
}

function stopReasonDetail(record: StageExecutionRecord | null): string {
  if (!record) return "Runtime publishes the stop record only after this stage exits.";
  if (record.reason == null) return "Runtime has not published a stop reason yet.";
  if (record.metric_name && record.metric_value != null && record.threshold != null) {
    return `${record.metric_name}: ${formatCompact(record.metric_value)} / ${formatCompact(record.threshold)}`;
  }
  return "Runtime completed the stage without a numeric stop metric.";
}

export function buildRelaxationInspectorState(args: {
  payload: Record<string, unknown>;
  stageExecutionRecord: StageExecutionRecord | null;
  stageStatus: string | null;
  scalarRows: ScalarRow[];
  liveState?: LiveState | null;
}): RelaxationInspectorState {
  const torqueTolerance = parseOptionalNumber(args.payload.torque_tolerance);
  const energyTolerance = parseOptionalNumber(args.payload.energy_tolerance);
  const maxSteps = parseOptionalPositiveInteger(args.payload.max_steps);
  const maxPseudotime = parseOptionalNumber(args.payload.max_pseudotime_s);
  const maxPhysicalTime = parseOptionalNumber(args.payload.max_physical_time_s);

  const latest = args.scalarRows.length > 0 ? args.scalarRows[args.scalarRows.length - 1] : null;
  const previous = args.scalarRows.length > 1 ? args.scalarRows[args.scalarRows.length - 2] : null;
  const torqueNow = latest?.max_torque_Apm ?? args.liveState?.max_torque_Apm ?? null;
  const energyDeltaNow =
    latest && previous ? Math.abs(latest.e_total - previous.e_total) : null;
  const stepsNow = latest?.step ?? args.liveState?.step ?? null;
  const timeNow = latest?.time ?? args.liveState?.time ?? null;

  const metrics: RelaxationProgressMetric[] = [];
  const convergenceProgress: number[] = [];

  if (torqueTolerance != null) {
    const progress = lowerIsBetterProgress(torqueNow, torqueTolerance);
    if (progress != null) convergenceProgress.push(progress);
    metrics.push({
      key: "torque",
      label: "Max torque",
      value: `${formatCompact(torqueNow, " A/m")} / ${formatCompact(torqueTolerance, " A/m")}`,
      detail: "Current |m x H_eff| residual against the requested torque tolerance.",
      progress,
      tone: progress === 100 ? "info" : "accent",
    });
  }

  if (energyTolerance != null) {
    const progress = lowerIsBetterProgress(energyDeltaNow, energyTolerance);
    if (progress != null) convergenceProgress.push(progress);
    metrics.push({
      key: "energy",
      label: "Energy delta",
      value: `${formatCompact(energyDeltaNow, " J")} / ${formatCompact(energyTolerance, " J")}`,
      detail: "Absolute |E_n - E_(n-1)| against the requested energy tolerance.",
      progress,
      tone: progress === 100 ? "info" : "accent",
    });
  }

  if (maxSteps != null) {
    const progress = upperBudgetProgress(stepsNow, maxSteps);
    metrics.push({
      key: "max_steps",
      label: "Step budget",
      value: `${stepsNow ?? 0} / ${maxSteps}`,
      detail: "Hard stop budget. Hitting it ends relaxation even if convergence is not reached.",
      progress,
      tone: progress != null && progress >= 100 ? "warn" : "default",
    });
  }

  if (maxPseudotime != null) {
    const progress = upperBudgetProgress(timeNow, maxPseudotime);
    metrics.push({
      key: "max_pseudotime",
      label: "Pseudotime budget",
      value: `${formatCompact(timeNow, " s")} / ${formatCompact(maxPseudotime, " s")}`,
      detail: "Hard stop budget for accumulated relaxation pseudotime.",
      progress,
      tone: progress != null && progress >= 100 ? "warn" : "default",
    });
  }

  if (maxPhysicalTime != null) {
    const progress = upperBudgetProgress(timeNow, maxPhysicalTime);
    metrics.push({
      key: "max_physical_time",
      label: "Physical time budget",
      value: `${formatCompact(timeNow, " s")} / ${formatCompact(maxPhysicalTime, " s")}`,
      detail: "Hard stop budget for simulated physical time.",
      progress,
      tone: progress != null && progress >= 100 ? "warn" : "default",
    });
  }

  const hasTorque = torqueTolerance != null;
  const hasEnergy = energyTolerance != null;
  const semantics = hasTorque && hasEnergy
    ? "Relax stops when both torque and energy delta are below threshold. Budget limits can still terminate the stage earlier."
    : hasTorque
      ? "Relax stops when torque falls below threshold. Budget limits can still terminate the stage earlier."
      : hasEnergy
        ? "Relax stops when energy delta falls below threshold. Budget limits can still terminate the stage earlier."
        : "No convergence threshold is set for this stage. Only hard budgets can stop the relaxation.";

  const finishedByRuntime =
    args.stageStatus === "completed" || args.stageStatus === "done" || args.stageExecutionRecord?.reason != null;
  const convergenceProgressValue =
    convergenceProgress.length > 0 ? Math.min(...convergenceProgress) : null;
  const torqueSummary =
    torqueTolerance != null
      ? `${formatCompact(torqueNow, " A/m")} / ${formatCompact(torqueTolerance, " A/m")}`
      : null;

  const overviewLabel = finishedByRuntime ? "Final stop" : "Convergence";
  const overviewValue = finishedByRuntime
    ? stopReasonLabel(args.stageExecutionRecord?.reason ?? null)
    : convergenceProgressValue != null
      ? `${Math.round(convergenceProgressValue)}% ready`
      : "Waiting for live telemetry";
  const overviewDetail = finishedByRuntime
    ? stopReasonDetail(args.stageExecutionRecord)
    : convergenceProgressValue != null
      ? torqueSummary != null
        ? `Max torque ${torqueSummary}. All enabled convergence criteria must be satisfied at the same time.`
        : "All enabled convergence criteria must be satisfied at the same time."
      : "Run the relax stage to evaluate live convergence against the configured criteria.";
  const overviewTone: Tone = finishedByRuntime
    ? args.stageExecutionRecord?.reason === "backend_error"
      ? "danger"
      : args.stageExecutionRecord?.reason === "max_steps" ||
          args.stageExecutionRecord?.reason === "max_pseudotime" ||
          args.stageExecutionRecord?.reason === "max_physical_time"
        ? "warn"
        : "info"
    : convergenceProgressValue != null
      ? "accent"
      : "default";

  return {
    overviewLabel,
    overviewValue,
    overviewDetail,
    overviewAuxValue: finishedByRuntime ? null : torqueSummary,
    overviewProgress: finishedByRuntime ? 100 : convergenceProgressValue,
    overviewTone,
    semantics,
    lastStopLabel: stopReasonLabel(args.stageExecutionRecord?.reason ?? null),
    lastStopDetail: stopReasonDetail(args.stageExecutionRecord),
    metrics,
  };
}
