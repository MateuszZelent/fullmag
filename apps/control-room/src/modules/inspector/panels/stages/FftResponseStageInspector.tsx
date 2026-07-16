"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import { SamplingDiagnostics } from "./SamplingDiagnostics";
import { resolveStudyWorkflowStateBefore } from "./studyWorkflowState";

export function FftResponseStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft?.kind === "fft_response" ? props.draft : null;
  const stateBefore = resolveStudyWorkflowStateBefore(
    props.pipelineDrafts ?? [],
    props.draftIndex,
  );
  const pipelineDrafts = props.pipelineDrafts ?? [];
  const nextRunIndex = pipelineDrafts.findIndex(
    (candidate, index) => index > props.draftIndex && candidate.kind === "run",
  );
  const nextRun = nextRunIndex >= 0 ? pipelineDrafts[nextRunIndex] : null;
  const effectiveState = nextRunIndex >= 0
    ? resolveStudyWorkflowStateBefore(pipelineDrafts, nextRunIndex)
    : stateBefore;
  const durationS = positiveNumber(nextRun?.untilSeconds);
  const disabled = !draft || draft.fftResponse.readOnly;

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="fft_response"
        kindLabel="FFT Response"
      />
      <InspectorSection
        value="fft-response-state"
        title="Gamma Response FFT"
        badge={draft?.fftResponse.enabled ? "ON" : "OFF"}
      >
        <FieldRow label="Physical duration" value="0 s" />
        <label className="fm-inspector-field">
          <span>Compute response FFT</span>
          <input
            checked={draft?.fftResponse.enabled ?? false}
            disabled={disabled}
            type="checkbox"
            onChange={(event) =>
              draft && props.onUpdateDraft({
                fftResponse: {
                  ...draft.fftResponse,
                  enabled: event.target.checked,
                },
              })
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Response component</span>
          <select
            className="fm-inspector-input"
            disabled={disabled || !draft?.fftResponse.enabled}
            value={draft?.fftResponse.responseComponent ?? "my"}
            onChange={(event) =>
              draft && props.onUpdateDraft({
                fftResponse: {
                  ...draft.fftResponse,
                  responseComponent: event.target.value as "my" | "mz",
                },
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
            disabled={disabled || !draft?.fftResponse.enabled}
            value={draft?.fftResponse.detrend ?? "linear"}
            onChange={(event) =>
              draft && props.onUpdateDraft({
                fftResponse: {
                  ...draft.fftResponse,
                  detrend: event.target.value as "linear" | "mean" | "none",
                },
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
            disabled={disabled || !draft?.fftResponse.enabled}
            min="0"
            step="1e-6"
            type="number"
            value={draft?.fftResponse.susceptibilityFloorFraction ?? ""}
            onChange={(event) =>
              draft && props.onUpdateDraft({
                fftResponse: {
                  ...draft.fftResponse,
                  susceptibilityFloorFraction: event.target.value,
                },
              })
            }
          />
        </label>
        <FieldRow
          label="Effect"
          value={
            draft?.fftResponse.enabled
              ? "enable Gamma response analysis for following Run stages until changed"
              : "disable response FFT for following Run stages until changed"
          }
        />
        {draft?.fftResponse.readOnly ? (
          <FeedbackBanner
            kind="warning"
            message="This imported analysis request is unsupported by the Gamma editor. Its payload is preserved losslessly and remains read-only."
          />
        ) : null}
      </InspectorSection>

      <InspectorSection
        value="fft-response-clock"
        title="Effective Response Clock"
        badge={stateBefore.tableAutosave?.sourceStageId ?? "missing t_sampling"}
      >
        <FieldRow
          label="t_sampling source"
          value={stateBefore.tableAutosave?.sourceStageId ?? "no preceding Table autosave ON stage"}
        />
        <FieldRow label="Following Run" value={nextRun?.stageId ?? "none"} />
        <SamplingDiagnostics
          durationS={durationS}
          sampling={effectiveState.tableAutosave}
        />
        {draft?.fftResponse.enabled && !stateBefore.tableAutosave ? (
          <FeedbackBanner
            kind="warning"
            message="FFT response needs a preceding Table autosave ON instruction to define t_sampling. The workflow remains invalid until that stage is added or enabled."
          />
        ) : null}
      </InspectorSection>
    </>
  );
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
