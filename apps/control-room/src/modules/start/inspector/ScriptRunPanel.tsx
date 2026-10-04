"use client";

import { Square } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/Button";

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
}

function ReadyView({ preflight, baseId, onRun }: ReadyProps) {
  const [options, setOptions] = useState<ScriptRunOptions>(DEFAULT_RUN_OPTIONS);
  const blocked = refusalOf(preflight);
  const nextToScript = options.results === "next_to_script";
  const needsConfirm = nextToScript && !options.confirmOverwrite;
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
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
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
        disabled={blocked !== null || needsConfirm}
        onClick={() => onRun(options)}
        size="sm"
        title={needsConfirm ? "Tick the box to write results next to the script" : undefined}
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
}

/**
 * The run flow of one script, shown inside the script inspector. Static facts
 * come first; the consent itself is a native window the host opens, so nothing
 * on this page can answer it.
 */
export function ScriptRunPanel({ controller }: ScriptRunPanelProps) {
  const baseId = useId();
  const { phase } = controller;
  if (phase.kind === "idle") return null;
  return (
    <section aria-labelledby={`${baseId}-title`} className="fm-start-kv fm-start-run" data-run-phase={phase.kind}>
      <h3 className="fm-start-kv__title" id={`${baseId}-title`}>
        Run in new window
      </h3>
      <PhaseBody baseId={baseId} controller={controller} phase={phase} />
    </section>
  );
}

function PhaseBody({
  baseId,
  controller,
  phase,
}: {
  readonly baseId: string;
  readonly controller: ScriptRunController;
  readonly phase: RunPhase;
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
            <strong>{stateLabel(phase.status.state)}</strong>
            {phase.status.windowOpen ? " · opened in its own window" : " · its window opens when the model is ready"}
          </p>
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
