"use client";

import { resolveHalfOpenSamplingClock } from "@/shared/domain/physics/sincPulsePreview";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import { resolveStudyWorkflowStateBefore } from "./studyWorkflowState";

export function TableAutosaveStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft?.kind === "table_autosave" ? props.draft : null;
  const stateBefore = resolveStudyWorkflowStateBefore(
    props.pipelineDrafts ?? [],
    props.draftIndex,
  );
  const nextRun = (props.pipelineDrafts ?? [])
    .slice(props.draftIndex + 1)
    .find((candidate) => candidate.kind === "run") ?? null;
  const durationS = positiveNumber(nextRun?.untilSeconds);
  const samplePeriodS = draft?.tableAutosave.enabled
    ? positiveNumber(draft.tableAutosave.samplePeriodS)
    : null;
  const samplingClock = durationS && samplePeriodS
    ? resolveHalfOpenSamplingClock(durationS, samplePeriodS)
    : null;

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="table_autosave"
        kindLabel="Table Autosave"
      />
      <InspectorSection
        value="table-autosave-state"
        title="Table Autosave State"
        badge={draft?.tableAutosave.enabled ? "ON" : "OFF"}
      >
        <FieldRow label="Physical duration" value="0 s" />
        <FieldRow
          label="Previous state"
          value={stateBefore.tableAutosave?.sourceStageId ?? "OFF"}
        />
        <label className="fm-inspector-field">
          <span>Table autosave</span>
          <input
            checked={draft?.tableAutosave.enabled ?? false}
            disabled={!draft}
            type="checkbox"
            onChange={(event) =>
              draft && props.onUpdateDraft({
                tableAutosave: {
                  ...draft.tableAutosave,
                  enabled: event.target.checked,
                },
              })
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>t_sampling (s)</span>
          <input
            className="fm-inspector-input"
            disabled={!draft?.tableAutosave.enabled}
            min="0"
            type="number"
            value={draft?.tableAutosave.samplePeriodS ?? ""}
            onChange={(event) =>
              draft && props.onUpdateDraft({
                tableAutosave: {
                  ...draft.tableAutosave,
                  samplePeriodS: event.target.value,
                },
              })
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Table quantities</span>
          <input
            className="fm-inspector-input"
            disabled={!draft?.tableAutosave.enabled}
            value={draft?.tableAutosave.tableQuantities ?? ""}
            onChange={(event) =>
              draft && props.onUpdateDraft({
                tableAutosave: {
                  ...draft.tableAutosave,
                  tableQuantities: event.target.value,
                },
              })
            }
          />
        </label>
        <FieldRow
          label="Effect"
          value={
            draft?.tableAutosave.enabled
              ? "set the common table/response clock for all following Run stages until changed"
              : "disable table sampling for all following Run stages until changed"
          }
        />
      </InspectorSection>

      <InspectorSection
        value="table-autosave-fft-clock"
        title="Response FFT Clock"
        badge={nextRun?.stageId ?? "no following Run"}
      >
        <FieldRow label="Following Run" value={nextRun?.stageId ?? "none"} />
        <div
          className="fm-sinc-preview__metrics"
          role="list"
          aria-label="Table autosave FFT clock parameters"
        >
          <Metric label="t_sampling" value={samplePeriodS ? engineering(samplePeriodS, "s") : "disabled"} />
          <Metric label="N" value={samplingClock ? String(samplingClock.sampleCount) : "not available"} />
          <Metric label="duration" value={durationS ? engineering(durationS, "s") : "not available"} />
          <Metric label="df" value={samplingClock ? engineering(samplingClock.frequencyResolutionHz, "Hz") : "not available"} />
          <Metric label="Nyquist" value={samplingClock ? engineering(samplingClock.nyquistHz, "Hz") : "not available"} />
        </div>
        <p className="fm-sinc-preview__message fm-sinc-preview__message--ready">
          FFT parameters use the half-open clock t_n = n t_sampling, t_n &lt; T, for the next Run. Runtime certification still uses the timestamps actually written.
        </p>
      </InspectorSection>
    </>
  );
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
  const exponent = value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  const prefixes: Record<number, string> = {
    [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m",
    0: "", 3: "k", 6: "M", 9: "G", 12: "T",
  };
  const prefix = prefixes[exponent];
  return prefix === undefined
    ? `${value.toExponential(3)} ${unit}`.trim()
    : `${(value / 10 ** exponent).toPrecision(4)} ${prefix}${unit}`.trim();
}
