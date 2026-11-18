"use client";

import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  Circle,
  Pause,
  SkipForward,
  X,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import type { StageExecutionResource } from "@/kernel/api/apiTypes";
import { useMeshBuildCurrent } from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import {
  useCommandQueueResource,
  useCurrentRunResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSimulationPreparation } from "@/kernel/resources/useSimulationPreparation";
import { Button } from "@/shared/ui/Button";
import { Progress } from "@/shared/ui/Progress";

import { MeshJobsPanel } from "./MeshJobsPanel";
import {
  buildRunProgressModel,
  estimateRemainingMs,
  formatClockTime,
  formatRunDuration,
  runStepElapsedMs,
  type RunActivityRow,
  type RunProgressModel,
  type RunStepRow,
  type RunStepState,
} from "./runProgressModel";

const LIVE_PHASES = new Set<RunProgressModel["phase"]>(["preparing", "running"]);

export function RunProgressPanel({
  sessionSolverState,
  stageExecution,
}: {
  sessionSolverState: string | null;
  stageExecution: Pick<ResourceResult<StageExecutionResource | null>, "data" | "error" | "status">;
}) {
  const commandQueue = useCommandQueueResource();
  const currentRun = useCurrentRunResource();
  const meshBuild = useMeshBuildCurrent();
  const preparation = useSimulationPreparation();
  const model = buildRunProgressModel({
    commandQueue: commandQueue.data,
    currentRun: currentRun.data,
    meshBuild: meshBuild.data,
    preparation: preparation.data,
    resources: [
      { error: commandQueue.error, label: "Commands", status: commandQueue.status },
      { error: currentRun.error, label: "Current run", status: currentRun.status },
      { error: meshBuild.error, label: "Mesh build", status: meshBuild.status },
      { error: preparation.error, label: "Preparation", status: preparation.status },
      { error: stageExecution.error, label: "Stage execution", status: stageExecution.status },
    ],
    sessionSolverState,
    stageExecution: stageExecution.data,
  });
  return <RunProgressView model={model} />;
}

function subscribeSecondClock(onTick: () => void): () => void {
  const timer = window.setInterval(onTick, 1000);
  return () => window.clearInterval(timer);
}

function subscribeNothing(): () => void {
  return () => {};
}

function readSecondClock(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

function readNoClock(): null {
  return null;
}

/**
 * Wall clock in whole seconds, ticking only while something is running; idle
 * panels never redraw. The server snapshot is null so hydration matches SSR.
 */
function useLiveClock(live: boolean): number | null {
  return useSyncExternalStore<number | null>(
    live ? subscribeSecondClock : subscribeNothing,
    live ? readSecondClock : readNoClock,
    readNoClock,
  );
}

export function RunProgressView({ model }: { model: RunProgressModel }) {
  const live = LIVE_PHASES.has(model.phase);
  const nowMs = useLiveClock(live);
  const [meshDetails, setMeshDetails] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const runEnd = model.endedAtMs ?? (live ? nowMs : null);
  const runElapsed = model.startedAtMs === null || runEnd === null
    ? null
    : Math.max(0, runEnd - model.startedAtMs);
  const focusStep = model.steps.find((step) => step.state === "active" && step.kind !== "mesh");
  const focusRemaining = focusStep
    ? estimateRemainingMs(focusStep.percent, runStepElapsedMs(focusStep, nowMs))
    : null;
  const empty = model.steps.length === 0 && model.activity.length === 0;

  return (
    <div className="fm-run-progress" data-footer-panel="operations" data-phase={model.phase}>
      <div className="fm-run-progress__summary">
        <span className="fm-run-progress__headline" data-phase={model.phase} role="status">
          <StepGlyph state={phaseGlyph(model.phase)} />
          {model.headline}
        </span>
        {model.focus ? <span className="fm-run-progress__focus" title={model.focus}>{model.focus}</span> : null}
        <span className="fm-run-progress__overall">
          {model.overallPercent !== null ? (
            <>
              <Progress
                value={model.overallPercent}
                aria-label="Overall run progress"
                className="fm-run-progress__overall-bar"
                data-run-phase={model.phase}
              />
              <span className="fm-run-progress__overall-value">{model.overallPercent}%</span>
            </>
          ) : null}
        </span>
        <dl className="fm-run-progress__clock">
          {runElapsed !== null ? (
            <div>
              <dt>Elapsed</dt>
              <dd>{formatRunDuration(runElapsed)}</dd>
            </div>
          ) : null}
          {focusRemaining !== null ? (
            <div title="Linear estimate for the active step from its published progress">
              <dt>Step left</dt>
              <dd>~{formatRunDuration(focusRemaining)}</dd>
            </div>
          ) : null}
        </dl>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="fm-run-progress__mesh-toggle"
          aria-expanded={meshDetails}
          aria-controls="fm-run-progress-mesh-details"
          onClick={() => setMeshDetails((value) => !value)}
        >
          {meshDetails ? "Hide mesh builds" : "Mesh builds"}
        </Button>
      </div>

      {model.steps.length > 0 ? <RunRibbon steps={model.steps} nowMs={nowMs} /> : null}

      {model.failure ? (
        <div className="fm-run-progress__failure" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{model.failure}</span>
        </div>
      ) : null}
      {model.gaps.length > 0 ? (
        <div className="fm-run-progress__gaps" role="status">
          {model.gaps.map((gap) => <span key={gap}>{gap}</span>)}
        </div>
      ) : null}

      <div className="fm-run-progress__body">
        {empty ? (
          <p className="fm-run-progress__empty">
            No run in this session yet. Press Compute or run a script; preparation, every study
            stage, progress, timings and errors will be tracked here.
          </p>
        ) : (
          <>
            <StepTable
              steps={model.steps}
              nowMs={nowMs}
              isExpanded={(step) => expanded[step.id] ?? defaultExpanded(step)}
              onToggle={(step) =>
                setExpanded((current) => ({
                  ...current,
                  [step.id]: !(current[step.id] ?? defaultExpanded(step)),
                }))
              }
            />
            <ActivityLog rows={model.activity} />
          </>
        )}
      </div>

      {meshDetails ? (
        <div className="fm-run-progress__mesh-details" id="fm-run-progress-mesh-details">
          <MeshJobsPanel />
        </div>
      ) : null}
    </div>
  );
}

function defaultExpanded(step: RunStepRow): boolean {
  return step.children.length > 0 && (step.state === "active" || step.state === "failed");
}

function phaseGlyph(phase: RunProgressModel["phase"]): RunStepState {
  switch (phase) {
    case "preparing":
    case "running":
      return "active";
    case "idle":
      return "pending";
    default:
      return phase;
  }
}

const STATE_LABELS: Record<RunStepState, string> = {
  active: "Running",
  cancelled: "Stopped",
  completed: "Done",
  failed: "Failed",
  paused: "Paused",
  pending: "Waiting",
  skipped: "Skipped",
};

function StepGlyph({ state }: { state: RunStepState }) {
  const icon = (() => {
    switch (state) {
      case "completed": return <Check size={11} strokeWidth={3} />;
      case "failed": return <X size={11} strokeWidth={3} />;
      case "paused": return <Pause size={10} strokeWidth={3} />;
      case "cancelled": return <Ban size={10} strokeWidth={2.5} />;
      case "skipped": return <SkipForward size={10} strokeWidth={2.5} />;
      case "active": return null;
      default: return <Circle size={6} strokeWidth={0} fill="currentColor" />;
    }
  })();
  return (
    <span className="fm-run-progress__glyph" data-state={state} aria-hidden="true">
      {icon}
    </span>
  );
}

/**
 * The run at a glance: one segment per top-level step, sized by the time it
 * has taken so far (square-root scaled so a long stage does not erase short
 * ones). Waiting steps keep a minimum width so the remaining work stays visible.
 */
function RunRibbon({ steps, nowMs }: { steps: readonly RunStepRow[]; nowMs: number | null }) {
  const summary = steps
    .map((step) => `${stepName(step)} ${STATE_LABELS[step.state].toLowerCase()}`)
    .join(", ");
  return (
    <ol className="fm-run-progress__ribbon" aria-label={`Run steps: ${summary}`}>
      {steps.map((step) => {
        const elapsed = runStepElapsedMs(step, nowMs);
        const weight = elapsed === null ? 1 : Math.max(1, Math.sqrt(elapsed / 1000));
        const fill = step.state === "completed" || step.state === "skipped"
          ? 100
          : step.percent ?? (step.state === "failed" || step.state === "cancelled" ? 100 : 0);
        return (
          <li
            key={step.id}
            className="fm-run-progress__segment"
            data-state={step.state}
            style={{ flexGrow: weight }}
            title={[
              stepName(step),
              STATE_LABELS[step.state],
              step.percent !== null && step.state === "active" ? `${Math.round(step.percent)}%` : null,
              elapsed !== null ? formatRunDuration(elapsed) : null,
            ].filter(Boolean).join("\n")}
          >
            <span className="fm-run-progress__segment-fill" style={{ width: `${fill}%` }} />
            <span className="fm-run-progress__segment-label">{stepName(step)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function stepName(step: RunStepRow): string {
  return step.ordinal !== null ? `${step.ordinal}. ${step.title}` : step.title;
}

function StepTable({
  isExpanded,
  nowMs,
  onToggle,
  steps,
}: {
  isExpanded: (step: RunStepRow) => boolean;
  nowMs: number | null;
  onToggle: (step: RunStepRow) => void;
  steps: readonly RunStepRow[];
}) {
  return (
    <div className="fm-run-progress__steps-scroll">
      <table className="fm-run-progress__steps" aria-label="Run steps">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Progress</th>
            <th scope="col" className="fm-run-progress__result">Result</th>
            <th scope="col" className="fm-run-progress__col-time">Time</th>
            <th scope="col" className="fm-run-progress__col-start">Started</th>
          </tr>
        </thead>
        <tbody>
          {steps.flatMap((step) => {
            const open = isExpanded(step);
            return [
              <StepRow
                key={step.id}
                step={step}
                nowMs={nowMs}
                expanded={step.children.length > 0 ? open : undefined}
                onToggle={() => onToggle(step)}
              />,
              ...(open
                ? step.children.map((child) => (
                    <StepRow key={child.id} step={child} nowMs={nowMs} nested />
                  ))
                : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function StepRow({
  expanded,
  nested = false,
  nowMs,
  onToggle,
  step,
}: {
  expanded?: boolean;
  nested?: boolean;
  nowMs: number | null;
  onToggle?: () => void;
  step: RunStepRow;
}) {
  const elapsed = runStepElapsedMs(step, nowMs);
  const showBar = step.state !== "pending" && step.state !== "skipped";
  return (
    <tr
      className="fm-run-progress__row"
      data-kind={step.kind}
      data-state={step.state}
      data-step-id={step.id}
    >
      <th scope="row" className="fm-run-progress__step">
        <span className="fm-run-progress__step-line">
          {expanded !== undefined ? (
            <button
              type="button"
              className="fm-run-progress__disclosure"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} ${step.title} steps`}
              onClick={onToggle}
            >
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          ) : (
            <span className="fm-run-progress__disclosure-space" aria-hidden="true" />
          )}
          <StepGlyph state={step.state} />
          {step.ordinal !== null ? <span className="fm-run-progress__ordinal">{step.ordinal}</span> : null}
          <span className="fm-run-progress__step-title">{step.title}</span>
          <span className="fm-visually-hidden">{STATE_LABELS[step.state]}</span>
          {step.subtitle ? <span className="fm-run-progress__step-subtitle">{step.subtitle}</span> : null}
        </span>
        {step.message && !nested ? (
          <span className="fm-run-progress__message" data-tone={step.messageTone}>{step.message}</span>
        ) : null}
      </th>
      <td className="fm-run-progress__progress">
        {showBar ? (
          <span className="fm-run-progress__bar-line">
            <Progress
              value={step.percent ?? (step.state === "completed" ? 100 : null)}
              aria-label={`${step.title} progress`}
              className="fm-run-progress__bar"
              data-step-state={step.state}
              data-indeterminate={step.percent === null && step.state === "active" ? "true" : undefined}
            />
            <span className="fm-run-progress__percent">
              {step.percent !== null ? `${Math.round(step.percent)}%` : step.state === "active" ? "…" : ""}
            </span>
          </span>
        ) : (
          <span className="fm-run-progress__waiting">{STATE_LABELS[step.state]}</span>
        )}
        {step.progressLabel && step.state === "active" ? (
          <span className="fm-run-progress__progress-label">{step.progressLabel}</span>
        ) : null}
      </td>
      <td className="fm-run-progress__result">
        {step.metric ? (
          <span className="fm-run-progress__metric">
            <span className="fm-run-progress__metric-label">{step.metric.label}</span>
            <span className="fm-run-progress__metric-value">{step.metric.value}</span>
            {step.metric.target ? (
              <span className="fm-run-progress__metric-target">target {step.metric.target}</span>
            ) : null}
          </span>
        ) : null}
        {step.message && nested ? (
          <span className="fm-run-progress__message" data-tone={step.messageTone}>{step.message}</span>
        ) : null}
        {!step.metric && !(step.message && nested) && step.progressLabel && step.state !== "active" ? (
          <span className="fm-run-progress__progress-label">{step.progressLabel}</span>
        ) : null}
      </td>
      <td className="fm-run-progress__time fm-run-progress__col-time">
        {elapsed !== null ? formatRunDuration(elapsed) : ""}
      </td>
      <td className="fm-run-progress__time fm-run-progress__col-start">
        {formatClockTime(step.startedAtMs)}
      </td>
    </tr>
  );
}

function ActivityLog({ rows }: { rows: readonly RunActivityRow[] }) {
  const problems = rows.filter((row) => row.tone === "danger" || row.tone === "warning").length;
  return (
    <section className="fm-run-progress__activity" aria-label="Run activity">
      <h3 className="fm-run-progress__activity-title">
        Activity
        <span className="fm-run-progress__activity-count">
          {rows.length}
          {problems > 0 ? <span data-tone="danger"> {problems} need attention</span> : null}
        </span>
      </h3>
      {rows.length > 0 ? (
        <ol className="fm-run-progress__activity-list">
          {rows.map((row) => (
            <li
              key={row.id}
              className="fm-run-progress__event"
              data-tone={row.tone}
              data-operation-id={row.operationId ?? undefined}
            >
              <time className="fm-run-progress__event-time">{formatClockTime(row.atMs)}</time>
              <span className="fm-run-progress__event-body">
                <span className="fm-run-progress__event-head">
                  <span className="fm-run-progress__event-source">{row.source}</span>
                  <span
                    className={row.source === "Command"
                      ? "fm-run-progress__event-text fm-run-progress__event-text--command"
                      : "fm-run-progress__event-text"}
                  >
                    {row.text}
                  </span>
                  {row.status ? <span className="fm-run-progress__event-status">{row.status}</span> : null}
                  {row.durationMs !== null ? (
                    <span className="fm-run-progress__event-duration">{formatRunDuration(row.durationMs)}</span>
                  ) : null}
                </span>
                {row.detail ? <span className="fm-run-progress__event-detail">{row.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="fm-run-progress__activity-empty">No commands or preparation messages yet.</p>
      )}
    </section>
  );
}
