"use client";

import { Square } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/Button";

import {
  executionAvailabilityFor,
  type ExecutionAvailability,
} from "../model/executionAvailability";
import {
  DEFAULT_RUN_OPTIONS,
  preflightLines,
  receiptText,
  refusalMessage,
  stateLabel,
  type FactLine,
  type RunPhase,
  type ScriptRunOptions,
  type ScriptPreflight,
} from "../model/scriptRun";
import type { ScriptRunController } from "../model/useScriptRun";

const DEVICE_CHOICES: readonly { readonly value: ScriptRunOptions["device"]; readonly label: string }[] = [
  { value: "as_authored", label: "As written in the script" },
  { value: "auto", label: "Automatic" },
  { value: "cpu", label: "CPU only" },
  { value: "gpu", label: "GPU only (no CPU fallback)" },
];

const TONE_CLASS: Readonly<Record<FactLine["tone"], string>> = {
  ok: "fm-start-run-fact--ok",
  warning: "fm-start-run-fact--warning",
  danger: "fm-start-run-fact--danger",
  neutral: "",
};

function Facts({ lines }: { readonly lines: readonly FactLine[] }) {
  return (
    <dl className="fm-start-kv__grid">
      {lines.map((line) => (
        <div className="fm-start-kv__row" key={line.label}>
          <dt>{line.label}</dt>
          <dd className={TONE_CLASS[line.tone]}>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function refusalOf(preflight: ScriptPreflight): string | null {
  if (preflight.refusal) return refusalMessage(preflight.refusal.code, preflight.refusal.detail);
  if (preflight.activeRuns >= preflight.maxRuns) {
    return refusalMessage("busy", `${preflight.maxRuns} runs are active; stop one first.`);
  }
  return null;
}

interface ReadyProps {
  readonly preflight: ScriptPreflight;
  readonly baseId: string;
  readonly onRun: (options: ScriptRunOptions) => void;
  readonly executionAvailability?: ExecutionAvailability;
}

function ReadyView({ preflight, baseId, onRun, executionAvailability }: ReadyProps) {
  const [options, setOptions] = useState<ScriptRunOptions>(DEFAULT_RUN_OPTIONS);
  const availability = executionAvailabilityFor(executionAvailability, "auto");
  const blocked = refusalOf(preflight);
  const nextToScript = options.results === "next_to_script";
  const needsConfirm = nextToScript && !options.confirmOverwrite;
  const selectedGpuUnavailable = options.device === "gpu" && !availability.gpu.enabled;
  const runBlocked = blocked !== null || needsConfirm || selectedGpuUnavailable;
  const lines = preflight.facts ? preflightLines(preflight.facts) : [];
  return (
    <>
      {preflight.facts?.degraded ? (
        <p className="fm-start-inspector__note">
          Python could not inspect this file ({preflight.facts.degradedReason ?? "no reason given"}), so
          the facts below are not checked.
        </p>
      ) : null}
      {lines.length > 0 ? <Facts lines={lines} /> : null}
      {preflight.warning ? (
        <div className="fm-start-banner fm-start-banner--warning" role="status">
          <div className="fm-start-banner__copy">{preflight.warning}</div>
        </div>
      ) : null}
      {blocked ? (
        <div className="fm-start-banner fm-start-banner--danger" role="alert">
          <div className="fm-start-banner__copy">{blocked}</div>
        </div>
      ) : null}
      <div className="fm-start-run-options">
        <label className="fm-start-run-field" htmlFor={`${baseId}-device`}>
          <span>Device</span>
          <select
            id={`${baseId}-device`}
            onChange={(event) =>
              setOptions({ ...options, device: event.target.value as ScriptRunOptions["device"] })
            }
            value={options.device}
          >
            {DEVICE_CHOICES.map((choice) => (
              <option
                disabled={choice.value === "gpu" && !availability.gpu.enabled}
                key={choice.value}
                title={choice.value === "gpu" && !availability.gpu.enabled ? availability.gpu.reason : undefined}
                value={choice.value}
              >
                {choice.value === "gpu" && !availability.gpu.enabled
                  ? `${choice.label} (unavailable)`
                  : choice.label}
              </option>
            ))}
          </select>
        </label>
        {!availability.gpu.enabled ? (
          <p className="fm-start-inspector__note" role="status">
            GPU is unavailable: {availability.gpu.reason}
          </p>
        ) : null}
        <label className="fm-start-run-check">
          <input
            checked={options.waitForSolve}
            onChange={(event) => setOptions({ ...options, waitForSolve: event.target.checked })}
            type="checkbox"
          />
          <span>Build the model, then wait for COMPUTE</span>
        </label>
        <fieldset className="fm-start-run-results">
          <legend>Results</legend>
          <label className="fm-start-run-check">
            <input
              checked={options.results === "managed"}
              name={`${baseId}-results`}
              onChange={() => setOptions({ ...options, results: "managed", confirmOverwrite: false })}
              type="radio"
            />
            <span>In a Fullmag run folder (default)</span>
          </label>
          <label className="fm-start-run-check">
            <input
              checked={nextToScript}
              name={`${baseId}-results`}
              onChange={() => setOptions({ ...options, results: "next_to_script" })}
              type="radio"
            />
            <span>Next to the script</span>
          </label>
          {nextToScript ? (
            <label className="fm-start-run-check fm-start-run-check--nested">
              <input
                checked={options.confirmOverwrite}
                onChange={(event) => setOptions({ ...options, confirmOverwrite: event.target.checked })}
                type="checkbox"
              />
              <span>
                Write results into a folder beside the script. An existing results folder is kept; a
                new numbered folder is created.
              </span>
            </label>
          ) : null}
        </fieldset>
      </div>
      <p className="fm-start-inspector__note" id={`${baseId}-consent`}>
        Fullmag asks for your confirmation in a separate window before anything runs. The script runs
        with your user permissions: it can read and write files and use the network.
      </p>
      <Button
        aria-describedby={`${baseId}-consent`}
        data-action="confirm-run"
        disabled={runBlocked}
        onClick={() => {
          if (runBlocked) return;
          onRun(options);
        }}
        size="sm"
        title={
          selectedGpuUnavailable
            ? availability.gpu.reason
            : needsConfirm
              ? "Tick the box to write results next to the script"
              : undefined
        }
        type="button"
        variant="primary"
      >
        Review and run…
      </Button>
    </>
  );
}

export interface ScriptRunPanelProps {
  readonly controller: ScriptRunController;
  readonly executionAvailability?: ExecutionAvailability;
}

/**
 * The run flow of one script, shown inside the script inspector. Static facts
 * come first; the consent itself is a native window the host opens, so nothing
 * on this page can answer it.
 */
export function ScriptRunPanel({ controller, executionAvailability }: ScriptRunPanelProps) {
  const baseId = useId();
  const { phase } = controller;
  if (phase.kind === "idle") return null;
  return (
    <section aria-labelledby={`${baseId}-title`} className="fm-start-kv fm-start-run" data-run-phase={phase.kind}>
      <h3 className="fm-start-kv__title" id={`${baseId}-title`}>
        Run in new window
      </h3>
      <PhaseBody
        baseId={baseId}
        controller={controller}
        executionAvailability={executionAvailability}
        phase={phase}
      />
    </section>
  );
}

function PhaseBody({
  baseId,
  controller,
  executionAvailability,
  phase,
}: {
  readonly baseId: string;
  readonly controller: ScriptRunController;
  readonly phase: RunPhase;
  readonly executionAvailability?: ExecutionAvailability;
}) {
  switch (phase.kind) {
    case "idle":
      return null;
    case "preparing":
      return (
        <p className="fm-start-inspector__note" role="status">
          Reading the file. Nothing is executed.
        </p>
      );
    case "ready":
      return (
        <>
          <ReadyView
            baseId={baseId}
            onRun={(options) => void controller.run(options)}
            preflight={phase.preflight}
            executionAvailability={executionAvailability}
          />
          <Button
            data-action="cancel-run"
            onClick={controller.dismiss}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </>
      );
    case "asking":
      return (
        <p className="fm-start-inspector__note" role="status">
          Waiting for your answer in the confirmation window. Nothing has run yet.
        </p>
      );
    case "active":
      return (
        <>
          <p className="fm-start-run-state" role="status">
            <strong>{stateLabel(phase.status.state, phase.status.unknownState)}</strong>
            {phase.status.phaseDetail ? ` · ${phase.status.phaseDetail}` : null}
            {phase.status.windowOpen ? " · opened in its own window" : " · its window opens when the model is ready"}
          </p>
          {phase.status.state === "unknown" ? (
            <div className="fm-start-banner fm-start-banner--warning" role="status">
              <div className="fm-start-banner__copy">
                The app reported a run state this panel does not recognise
                {phase.status.unknownState ? ` (${phase.status.unknownState})` : ""}. The run is treated
                as still active: no new run can start here until it reports a known state. Stop remains available.
              </div>
            </div>
          ) : null}
          {phase.warning ? (
            <div className="fm-start-banner fm-start-banner--warning" role="status">
              <div className="fm-start-banner__copy">{phase.warning}</div>
            </div>
          ) : null}
          {phase.status.error ? (
            <div className="fm-start-banner fm-start-banner--danger" role="alert">
              <div className="fm-start-banner__copy">{phase.status.error}</div>
            </div>
          ) : null}
          <Button data-action="stop-run" onClick={() => void controller.stop()} size="sm" type="button" variant="danger">
            <Square aria-hidden="true" size={12} />
            Stop run
          </Button>
        </>
      );
    case "finished": {
      const receipt = phase.status.receipt;
      return (
        <>
          <div
            className={`fm-start-banner fm-start-banner--${receipt?.outcome === "completed" ? "info" : receipt?.outcome === "cancelled" ? "warning" : "danger"}`}
            role={receipt?.outcome === "completed" ? "status" : "alert"}
          >
            <div className="fm-start-banner__copy">
              {receipt ? receiptText(receipt) : "The run ended without a receipt."}
            </div>
          </div>
          {receipt?.resultsDir ? (
            <p className="fm-start-inspector__note">Results: {receipt.resultsDir}</p>
          ) : null}
          <Button data-action="dismiss-run" onClick={controller.dismiss} size="sm" type="button" variant="secondary">
            Close
          </Button>
        </>
      );
    }
    case "failed":
      return (
        <>
          <div className="fm-start-banner fm-start-banner--danger" role="alert">
            <div className="fm-start-banner__copy">{phase.message}</div>
          </div>
          <Button data-action="dismiss-run" onClick={controller.dismiss} size="sm" type="button" variant="secondary">
            Close
          </Button>
        </>
      );
  }
}
