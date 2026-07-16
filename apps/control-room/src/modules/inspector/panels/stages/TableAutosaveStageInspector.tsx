"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import { SamplingDiagnostics, engineering } from "./SamplingDiagnostics";
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
            disabled={!draft || readOnly}
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
          <span>Sampling mode</span>
          <select
            className="fm-inspector-input"
            disabled={!draft?.tableAutosave.enabled || readOnly}
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
          </select>
        </label>
        <label className="fm-inspector-field">
          <span>t_sampling (s)</span>
          <input
            className="fm-inspector-input"
            disabled={
              !draft?.tableAutosave.enabled ||
              readOnly ||
              draft.tableAutosave.samplingMode === "auto_sinc_cutoff"
            }
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
            disabled={!draft?.tableAutosave.enabled || readOnly}
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
        {readOnly ? (
          <FeedbackBanner
            kind="warning"
            message="This imported table sampling policy is unsupported by the editor. Its payload is preserved losslessly and remains read-only."
          />
        ) : null}
      </InspectorSection>

      <InspectorSection
        value="table-autosave-fft-clock"
        title="Response FFT Clock"
        badge={nextRun?.stageId ?? "no following Run"}
      >
        <FieldRow label="Following Run" value={nextRun?.stageId ?? "none"} />
        <FieldRow
          label="Duration"
          value={durationS ? engineering(durationS, "s") : "not available"}
        />
        <SamplingDiagnostics durationS={durationS} sampling={effectiveSampling} />
        <p className="fm-sinc-preview__message fm-sinc-preview__message--ready">
          FFT parameters use the half-open clock t_n = n t_sampling, t_n &lt; T, for the next Run. Runtime certification still uses the timestamps actually written.
        </p>
      </InspectorSection>
    </>
  );
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
