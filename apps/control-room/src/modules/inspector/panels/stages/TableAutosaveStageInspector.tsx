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
import { formatEngineering } from "./samplingPresentation";
import { resolveStudyWorkflowStateBefore } from "./studyWorkflowState";

export function TableAutosaveStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft?.kind === "table_autosave" ? props.draft : null;
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
    : null;
  const effectiveSampling = effectiveState?.tableAutosave ?? null;
  const durationS = positiveNumber(nextRun?.untilSeconds);
  const readOnly = draft?.tableAutosave.readOnly ?? false;

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="table_autosave"
        kindLabel="Table Autosave"
      />
      <InspectorGroup
        title="Table Autosave State"
        badge={draft?.tableAutosave.enabled ? "ON" : "OFF"}
      >
        <FieldRow label="Physical duration" value="0 s" />
        <FieldRow
          label="Previous state"
          value={stateBefore.tableAutosave?.sourceStageId ?? "OFF"}
        />
        <FormField
          checked={draft?.tableAutosave.enabled ?? false}
          disabled={!draft || readOnly}
          label="Table autosave"
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
        <FormField
          disabled={!draft?.tableAutosave.enabled || readOnly}
          label="Sampling mode"
          type="select"
          value={draft?.tableAutosave.samplingMode ?? "explicit"}
          onChange={(event) =>
            draft && props.onUpdateDraft({
              tableAutosave: {
                ...draft.tableAutosave,
                samplingMode: event.target.value as
                  | "auto_sinc_cutoff"
                  | "explicit",
              },
            })
          }
        >
            <option value="explicit">Explicit period</option>
            <option value="auto_sinc_cutoff">Automatic from sinc cutoff</option>
        </FormField>
        <FormField
          disabled={
            !draft?.tableAutosave.enabled ||
            readOnly ||
            draft.tableAutosave.samplingMode === "auto_sinc_cutoff"
          }
          label="t_sampling"
          min="0"
          type="number"
          unit="s"
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
        <FormField
          disabled={!draft?.tableAutosave.enabled || readOnly}
          label="Table quantities"
          mono={false}
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
        <FieldRow
          label="Effect"
          value={
            draft?.tableAutosave.enabled
              ? "set the common table/response clock for all following Run stages until changed"
              : "disable table sampling for all following Run stages until changed"
          }
        />
        {readOnly ? (
          <FeedbackBanner
            kind="warning"
            message="This imported table sampling policy is unsupported by the editor. Its payload is preserved losslessly and remains read-only."
          />
        ) : null}
      </InspectorGroup>

      <InspectorGroup
        title="Response FFT Clock"
        badge={nextRun?.stageId ?? "no following Run"}
      >
        <FieldRow label="Following Run" value={nextRun?.stageId ?? "none"} />
        <FieldRow
          label="Duration"
          value={durationS ? formatEngineering(durationS, "s") : "not available"}
        />
        <SamplingDiagnostics durationS={durationS} sampling={effectiveSampling} />
        <p className="fm-sinc-preview__message fm-sinc-preview__message--ready">
          FFT parameters use the half-open clock t_n = n t_sampling, t_n &lt; T, for the next Run. Runtime certification still uses the timestamps actually written.
        </p>
      </InspectorGroup>
    </>
  );
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
