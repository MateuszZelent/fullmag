"use client";

import { Plus, Trash2 } from "lucide-react";

import {
  buildSincPulsePreview,
  resolveHalfOpenSamplingClock,
} from "@/shared/domain/physics/sincPulsePreview";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { SincPulsePreview } from "../SincPulsePreview";
import { StudyProgressBar } from "../StudyProgressBar";
import type {
  StudyRunSamplingDraft,
  StudyStageDraft,
} from "../StudyStageAuthoringModel";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";

export function RunStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft?.kind === "run" ? props.draft : null;
  const stage = props.stage;
  const sampling = draft?.runSampling ?? null;
  const samplePeriodS = sampling?.tableAutosaveEnabled
    ? positiveNumber(sampling.samplePeriodS)
    : null;
  const durationS = positiveNumber(draft?.untilSeconds);
  const samplingClock = durationS && samplePeriodS
    ? resolveHalfOpenSamplingClock(durationS, samplePeriodS)
    : null;
  const fixedDtS = draft?.timestepMode === "fixed"
    ? positiveNumber(draft.dt)
    : null;
  const precedingDriveDraft = findPrecedingActiveDrive(
    props.pipelineDrafts ?? [],
    props.draftIndex,
    draft?.stageId ?? null,
  );
  const sourceDrive = precedingDriveDraft?.fieldDrive ?? null;
  const sourcePreview =
    sourceDrive?.waveform.kind === "sinc_pulse"
      ? buildSincPulsePreview({
          cutoffHz: sourceDrive.waveform.cutoff_hz,
          durationS,
          fieldAmplitudeT: sourceDrive.amplitude_B_T,
          samplePeriodS,
          t0S: sourceDrive.waveform.t0 ?? 0,
          waveformAmplitude: sourceDrive.waveform.amplitude ?? 1,
        })
      : null;

  function updateSampling(patch: Partial<StudyRunSamplingDraft>): void {
    if (!sampling) return;
    props.onUpdateDraft({ runSampling: { ...sampling, ...patch } });
  }

  return (
    <>
      <StageInspectorFrame {...props} expectedKind="run" kindLabel="Run" />
      <InspectorSection
        value="run-progress"
        title="Run Progress"
        badge={stage?.status ?? "not started"}
      >
        <StudyProgressBar
          indeterminate={
            stage?.status.toLowerCase() === "running" &&
            !stage.progressLabel &&
            !stage.progressDetail &&
            stage.progressPercent <= 0
          }
          label="Run time-domain progress"
          statusLabel={stage?.progressLabel ?? undefined}
          value={stage ? stage.progressPercent : null}
        />
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow
          label="Progress detail"
          value={stage?.progressDetail ?? "not available"}
        />
        <FieldRow
          label="Runtime metric"
          value={stage?.runtimeMetric?.value ?? "not available"}
        />
        <FieldRow
          label="Target"
          value={stage?.runtimeMetric?.threshold ?? "not available"}
        />
        <FieldRow label="Stop reason" value={stage?.stopReason ?? "not available"} />
      </InspectorSection>
      <InspectorSection
        value="run-time-integration"
        title="Time Integration"
        badge={stage?.status ?? "draft"}
      >
        <FieldRow
          label="Initial state"
          value="complete state produced by the preceding pipeline instruction"
        />
        <label className="fm-inspector-field">
          <span>Timestep policy</span>
          <select
            className="fm-inspector-input"
            disabled={!draft}
            value={draft?.timestepMode === "fixed" ? "fixed" : "auto"}
            onChange={(event) =>
              props.onUpdateDraft({
                dt: event.target.value === "fixed" && draft?.dt === "auto"
                  ? "1e-13"
                  : draft?.dt ?? "auto",
                timestepMode: event.target.value === "fixed" ? "fixed" : "auto",
              })
            }
          >
            <option value="auto">Runtime default</option>
            <option value="fixed">Fixed dt</option>
          </select>
        </label>
        {draft?.timestepMode === "fixed" ? (
          <label className="fm-inspector-field">
            <span>Integration dt (s)</span>
            <input
              className="fm-inspector-input"
              min="0"
              type="number"
              value={draft.dt}
              onChange={(event) => props.onUpdateDraft({ dt: event.target.value })}
            />
          </label>
        ) : null}
        <FieldRow label="Integrator" value={draft?.solver || "runtime default"} />
        <FieldRow label="Dynamics" value="LLG time evolution" />
      </InspectorSection>

      <InspectorSection value="run-drive" title="Drive & Dynamics">
        <FieldRow label="Start state" value="current magnetization state" />
        <FieldRow
          label="Antenna configuration"
          value={precedingDriveDraft?.fieldDrive.name ?? "no active preceding drive"}
        />
        <FieldRow
          label="Field evaluation"
          value="time-dependent Zeeman field evaluated during this Run only"
        />
      </InspectorSection>

      <InspectorSection
        value="run-sampling"
        title="Sampling & Outputs"
        badge={sampling?.tableAutosaveEnabled ? "stage local" : "disabled"}
      >
        <label className="fm-inspector-field">
          <span>Table autosave / response clock</span>
          <input
            checked={sampling?.tableAutosaveEnabled ?? false}
            disabled={!sampling}
            type="checkbox"
            onChange={(event) =>
              updateSampling({ tableAutosaveEnabled: event.target.checked })
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Response t_sampling (s)</span>
          <input
            className="fm-inspector-input"
            disabled={!sampling?.tableAutosaveEnabled}
            min="0"
            type="number"
            value={sampling?.samplePeriodS ?? ""}
            onChange={(event) => updateSampling({ samplePeriodS: event.target.value })}
          />
        </label>
        <label className="fm-inspector-field">
          <span>Table quantities</span>
          <input
            className="fm-inspector-input"
            disabled={!sampling?.tableAutosaveEnabled}
            value={sampling?.tableQuantities ?? ""}
            onChange={(event) => updateSampling({ tableQuantities: event.target.value })}
          />
        </label>
        <div className="fm-study-run-output-list" aria-label="Stage-local field and scalar outputs">
          {(sampling?.outputs ?? []).map((output, index) => (
            <div className="fm-study-run-output-row" key={`${index}:${output.name}`}>
              <input
                aria-label={`Enable output ${output.name || index + 1}`}
                checked={output.enabled}
                type="checkbox"
                onChange={(event) =>
                  updateSampling({
                    outputs: sampling?.outputs.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, enabled: event.target.checked }
                        : candidate,
                    ) ?? [],
                  })
                }
              />
              <select
                aria-label={`Output ${index + 1} kind`}
                className="fm-inspector-input"
                disabled={output.readOnly}
                value={output.kind}
                onChange={(event) =>
                  updateSampling({
                    outputs: sampling?.outputs.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? {
                            ...candidate,
                            kind: event.target.value as "field" | "scalar",
                          }
                        : candidate,
                    ) ?? [],
                  })
                }
              >
                <option value="field">Field</option>
                <option value="scalar">Scalar</option>
              </select>
              <input
                aria-label={`Output ${index + 1} name`}
                className="fm-inspector-input"
                disabled={output.readOnly}
                value={output.name}
                onChange={(event) =>
                  updateSampling({
                    outputs: sampling?.outputs.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, name: event.target.value }
                        : candidate,
                    ) ?? [],
                  })
                }
              />
              <input
                aria-label={`Output ${index + 1} cadence seconds`}
                className="fm-inspector-input"
                disabled={output.readOnly}
                min="0"
                type="number"
                value={output.everySeconds}
                onChange={(event) =>
                  updateSampling({
                    outputs: sampling?.outputs.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, everySeconds: event.target.value }
                        : candidate,
                    ) ?? [],
                  })
                }
              />
              {output.readOnly ? (
                <small>unsupported record preserved read-only</small>
              ) : (
                <Button
                  aria-label={`Remove output ${output.name || index + 1}`}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    updateSampling({
                      outputs: sampling?.outputs.filter(
                        (_, candidateIndex) => candidateIndex !== index,
                      ) ?? [],
                    })
                  }
                >
                  <Trash2 aria-hidden="true" size={13} />
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button
          disabled={!sampling}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() =>
            updateSampling({
              outputs: [
                ...(sampling?.outputs ?? []),
                {
                  enabled: true,
                  everySeconds: sampling?.samplePeriodS || "1e-12",
                  kind: "field",
                  name: "m",
                },
              ],
            })
          }
        >
          <Plus aria-hidden="true" size={13} /> Add output
        </Button>
        <div className="fm-sinc-preview__metrics" role="list" aria-label="Planned response FFT parameters">
          <Metric label="integration dt" value={fixedDtS ? engineering(fixedDtS, "s") : "runtime default"} />
          <Metric label="response dt" value={samplePeriodS ? engineering(samplePeriodS, "s") : "not declared"} />
          <Metric label="samples N" value={samplingClock ? String(samplingClock.sampleCount) : "not available"} />
          <Metric label="duration" value={durationS ? engineering(durationS, "s") : "not declared"} />
          <Metric label="df" value={samplingClock ? engineering(samplingClock.frequencyResolutionHz, "Hz") : "not available"} />
          <Metric label="Nyquist" value={samplingClock ? engineering(samplingClock.nyquistHz, "Hz") : "not available"} />
        </div>
        <p className="fm-sinc-preview__message fm-sinc-preview__message--ready">
          Planned FFT uses the half-open clock t_n = n t_sampling with t_n &lt; T.
          Actual response FFT is certified only from the timestamps produced by the run.
        </p>
      </InspectorSection>

      <InspectorSection
        value="run-gamma-response"
        title="Gamma Response"
        badge={sampling?.gammaResponseEnabled ? "FFT enabled" : "disabled"}
      >
        <label className="fm-inspector-field">
          <span>Compute k=0 response</span>
          <input
            checked={sampling?.gammaResponseEnabled ?? false}
            disabled={!sampling}
            type="checkbox"
            onChange={(event) =>
              updateSampling({ gammaResponseEnabled: event.target.checked })
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Response component</span>
          <select
            className="fm-inspector-input"
            disabled={!sampling?.gammaResponseEnabled}
            value={sampling?.gammaResponseComponent ?? "my"}
            onChange={(event) =>
              updateSampling({
                gammaResponseComponent: event.target.value as "my" | "mz",
              })
            }
          >
            <option value="my">my</option>
            <option value="mz">mz</option>
          </select>
        </label>
        <label className="fm-inspector-field">
          <span>Detrend</span>
          <select
            className="fm-inspector-input"
            disabled={!sampling?.gammaResponseEnabled}
            value={sampling?.gammaDetrend ?? "linear"}
            onChange={(event) =>
              updateSampling({
                gammaDetrend: event.target.value as "linear" | "mean" | "none",
              })
            }
          >
            <option value="none">None</option>
            <option value="mean">Remove mean</option>
            <option value="linear">Linear</option>
          </select>
        </label>
        <FieldRow label="Window" value="Hann" />
        <FieldRow label="Weighting" value="Ms × lumped volume" />
        <label className="fm-inspector-field">
          <span>Susceptibility floor fraction</span>
          <input
            className="fm-inspector-input"
            disabled={!sampling?.gammaResponseEnabled}
            min="0"
            step="1e-6"
            type="number"
            value={sampling?.susceptibilityFloorFraction ?? ""}
            onChange={(event) =>
              updateSampling({ susceptibilityFloorFraction: event.target.value })
            }
          />
        </label>
        {sourcePreview ? (
          <SincPulsePreview model={sourcePreview} solverDtS={fixedDtS} />
        ) : (
          <FeedbackBanner
            kind="warning"
            message="No active preceding sinc antenna was found for this Run. Response sampling remains editable, but source-spectrum verification is unavailable."
          />
        )}
        <FieldRow
          label="Actual response"
          value="published in Results / Spin-wave Gamma after the run; nonuniform timestamps are rejected without hidden resampling"
        />
      </InspectorSection>

      <InspectorSection value="run-results" title="Run Results">
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow
          label="Elapsed"
          value={stage?.runtimeMetric?.value ?? "not available"}
        />
        <FieldRow label="Checkpoint" value={stage?.checkpointRef ?? "not available"} />
        <FieldRow
          label="Artifacts"
          value={stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"}
        />
      </InspectorSection>
    </>
  );
}

function findPrecedingActiveDrive(
  drafts: readonly StudyStageDraft[],
  runIndex: number,
  runStageId: string | null,
): StudyStageDraft | null {
  for (let index = Math.min(runIndex - 1, drafts.length - 1); index >= 0; index -= 1) {
    const candidate = drafts[index];
    if (candidate.kind !== "add_field_drive" || !candidate.fieldDrive.enabled) continue;
    const activation = candidate.fieldDrive.activation;
    if (
      activation.kind === "all_time_evolution" ||
      (runStageId !== null && activation.stage_ids.includes(runStageId))
    ) {
      return candidate;
    }
  }
  return null;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span role="listitem"><small>{label}</small><strong>{value}</strong></span>;
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function engineering(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "invalid";
  if (value === 0) return `0 ${unit}`.trim();
  const exponent = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  const prefixes: Record<number, string> = {
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
  const prefix = prefixes[exponent];
  return prefix === undefined
    ? `${value.toExponential(3)} ${unit}`.trim()
    : `${(value / 10 ** exponent).toPrecision(4)} ${prefix}${unit}`.trim();
}
