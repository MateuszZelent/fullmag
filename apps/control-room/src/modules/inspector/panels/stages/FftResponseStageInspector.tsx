"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
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
  const finiteK = draft?.fftResponse.analysis === "finite_k";
  const unsupported = draft?.fftResponse.analysis === "unsupported";
  const rawComponent = draft?.fftResponse.rawRequest?.response_component;
  const unrecognizedComponent = Boolean(draft?.fftResponse.readOnly && (unsupported || (rawComponent !== undefined && rawComponent !== "my" && rawComponent !== "mz" && !(finiteK && rawComponent === "mx"))));
  const effectiveSampling = unsupported ? null : finiteK
    ? effectiveState.outputs.find((output) => output.quantity === "m" && output.outputKind === "field") ?? null
    : effectiveState.tableAutosave;
  const durationS = positiveNumber(nextRun?.untilSeconds);
  const disabled = !draft || draft.fftResponse.readOnly;

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="fft_response"
        kindLabel="FFT Response"
      />
      <InspectorGroup
        title={unsupported ? "Unrecognized Response Analysis" : finiteK ? "Finite-k Response FFT" : "Gamma Response FFT"}
        badge={draft?.fftResponse.enabled ? "ON" : "OFF"}
      >
        <FieldRow label="Physical duration" value="0 s" />
        <FormField
          checked={draft?.fftResponse.enabled ?? false}
          disabled={disabled}
          label="Compute response FFT"
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
        <FormField
          disabled={disabled || !draft?.fftResponse.enabled}
          label="Analysis"
          type="select"
          value={draft?.fftResponse.analysis ?? "gamma"}
          onChange={(event) => draft && props.onUpdateDraft({
            fftResponse: {
              ...draft.fftResponse,
              analysis: event.target.value as "gamma" | "finite_k",
              responseComponent: event.target.value === "gamma" && draft.fftResponse.responseComponent === "mx" ? "my" : draft.fftResponse.responseComponent,
            },
          })}
        >
          <option value="gamma">Gamma (k=0)</option>
          <option value="finite_k">Finite-k (FEM x cross-sections)</option>
          {unsupported ? <option value="unsupported">Unrecognized imported analysis</option> : null}
        </FormField>
        <FormField
          disabled={disabled || !draft?.fftResponse.enabled}
          label="Response component"
          type="select"
          value={unrecognizedComponent ? "unsupported" : draft?.fftResponse.responseComponent ?? "my"}
          onChange={(event) =>
            draft && props.onUpdateDraft({
              fftResponse: {
                ...draft.fftResponse,
                responseComponent: event.target.value as "mx" | "my" | "mz",
              },
            })
          }
        >
            {finiteK ? <option value="mx">mx</option> : null}
            {unrecognizedComponent ? <option value="unsupported">Unrecognized imported component</option> : null}
            <option value="my">my</option>
            <option value="mz">mz</option>
        </FormField>
        {finiteK ? (
          <>
            <FormField disabled={disabled || !draft?.fftResponse.enabled} label="Spatial probes" type="number" min="4" max="2048" step="1" value={draft?.fftResponse.probeCount ?? "128"}
              onChange={(event) => draft && props.onUpdateDraft({ fftResponse: { ...draft.fftResponse, probeCount: event.target.value } })} />
            <FormField disabled={disabled || !draft?.fftResponse.enabled} label="Lower x bound (m; blank = infer)" type="number" step="any" value={draft?.fftResponse.analysisXMinM ?? ""}
              onChange={(event) => draft && props.onUpdateDraft({ fftResponse: { ...draft.fftResponse, analysisXMinM: event.target.value } })} />
            <FormField disabled={disabled || !draft?.fftResponse.enabled} label="Upper x bound (m; blank = infer)" type="number" step="any" value={draft?.fftResponse.analysisXMaxM ?? ""}
              onChange={(event) => draft && props.onUpdateDraft({ fftResponse: { ...draft.fftResponse, analysisXMaxM: event.target.value } })} />
            <FieldRow label="Preprocessing" value="Subtract first snapshot; Hann in space and time" />
            <FeedbackBanner kind="warning" message="Requires FEM tet4/f64 snapshots of m and H_drive on matching time axes. This is response analysis, not the antenna source FFT or a qualified susceptibility." />
          </>
        ) : unsupported ? null : (
          <>
        <FormField
          disabled={disabled || !draft?.fftResponse.enabled}
          label="Detrend"
          type="select"
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
        </FormField>
        <FieldRow label="Window" value="Hann" />
        <FieldRow label="Weighting" value="Ms × lumped volume" />
        <FormField
          disabled={disabled || !draft?.fftResponse.enabled}
          label="Susceptibility floor fraction"
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
          </>
        )}
        <FieldRow
          label="Effect"
          value={
            draft?.fftResponse.enabled
              ? unsupported ? "Unrecognized imported analysis; inspect the preserved raw request" : `enable ${finiteK ? "finite-k" : "Gamma"} response analysis for following Run stages until changed`
              : "disable response FFT for following Run stages until changed"
          }
        />
        {draft?.fftResponse.readOnly ? (
          <FeedbackBanner
            kind="warning"
            message="This imported analysis request is unsupported by this editor. Its payload is preserved losslessly and remains read-only."
          />
        ) : null}
      </InspectorGroup>

      <InspectorGroup
        title="Effective Response Clock"
        badge={effectiveSampling?.sourceStageId ?? "missing t_sampling"}
      >
        <FieldRow
          label={finiteK ? "m field clock source" : "t_sampling source"}
          value={unsupported ? "not inferred for unrecognized analysis" : effectiveSampling?.sourceStageId ?? (finiteK ? "no m field autosave before the following Run" : "no Table autosave ON stage before the following Run")}
        />
        {finiteK ? <FieldRow label="H_drive field clock source" value={effectiveState.outputs.find((output) => output.quantity === "H_drive" && output.outputKind === "field")?.sourceStageId ?? "missing H_drive field autosave"} /> : null}
        <FieldRow label="Following Run" value={nextRun?.stageId ?? "none"} />
        <SamplingDiagnostics
          durationS={durationS}
          sampling={effectiveSampling}
        />
        {draft?.fftResponse.enabled && !unsupported && !effectiveSampling ? (
          <FeedbackBanner
            kind="warning"
            message={finiteK ? "Finite-k requires preceding field autosave instructions for m and H_drive with matching clocks." : "FFT response needs a preceding Table autosave ON instruction to define t_sampling. The workflow remains invalid until that stage is added or enabled."}
          />
        ) : null}
      </InspectorGroup>
    </>
  );
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
