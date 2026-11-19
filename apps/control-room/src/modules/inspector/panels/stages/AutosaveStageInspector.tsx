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

export function AutosaveStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft?.kind === "autosave" ? props.draft : null;
  const stateBefore = resolveStudyWorkflowStateBefore(
    props.pipelineDrafts ?? [],
    props.draftIndex,
  );
  const disabled = !draft || draft.autosave.readOnly;
  const pipelineDrafts = props.pipelineDrafts ?? [];
  const nextRunIndex = pipelineDrafts.findIndex(
    (candidate, index) => index > props.draftIndex && candidate.kind === "run",
  );
  const nextRun = nextRunIndex >= 0 ? pipelineDrafts[nextRunIndex] : null;
  const effectiveState = nextRunIndex >= 0
    ? resolveStudyWorkflowStateBefore(pipelineDrafts, nextRunIndex)
    : null;
  const effectiveOutput = effectiveState?.outputs.find(
    (output) => output.quantity === draft?.autosave.quantity,
  ) ?? null;
  const durationS = positiveNumber(nextRun?.untilSeconds);

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="autosave"
        kindLabel="Autosave"
      />
      <InspectorGroup
        title="Autosave Output State"
        badge={draft?.autosave.enabled ? "ON" : "OFF"}
      >
        <FieldRow label="Physical duration" value="0 s" />
        <FieldRow
          label="Currently active outputs"
          value={
            stateBefore.outputs.length
              ? stateBefore.outputs.map((output) => output.quantity).join(", ")
              : "none"
          }
        />
        <label className="fm-inspector-field">
          <span>Autosave quantity</span>
          <input
            checked={draft?.autosave.enabled ?? false}
            disabled={disabled}
            type="checkbox"
            onChange={(event) =>
              draft && props.onUpdateDraft({
                autosave: {
                  ...draft.autosave,
                  clearAll: false,
                  enabled: event.target.checked,
                },
              })
            }
          />
        </label>
        {!draft?.autosave.enabled ? (
          <label className="fm-inspector-field">
            <span>Clear every active autosave output</span>
            <input
              checked={draft?.autosave.clearAll ?? false}
              disabled={disabled}
              type="checkbox"
              onChange={(event) =>
                draft && props.onUpdateDraft({
                  autosave: {
                    ...draft.autosave,
                    clearAll: event.target.checked,
                    quantity: event.target.checked ? "" : draft.autosave.quantity || "m",
                  },
                })
              }
            />
          </label>
        ) : null}
        <label className="fm-inspector-field">
          <span>Quantity</span>
          <input
            className="fm-inspector-input"
            disabled={disabled || Boolean(draft?.autosave.clearAll)}
            value={draft?.autosave.quantity ?? ""}
            onChange={(event) =>
              draft && props.onUpdateDraft({
                autosave: {
                  ...draft.autosave,
                  quantity: event.target.value,
                },
              })
            }
          />
        </label>
        {draft?.autosave.enabled ? (
          <>
            <label className="fm-inspector-field">
              <span>Output kind</span>
              <select
                className="fm-inspector-input"
                disabled={disabled}
                value={draft.autosave.outputKind}
                onChange={(event) =>
                  props.onUpdateDraft({
                    autosave: {
                      ...draft.autosave,
                      outputKind: event.target.value as "field" | "scalar",
                    },
                  })
                }
              >
                <option value="field">Field</option>
                <option value="scalar">Scalar</option>
              </select>
            </label>
            <FormField
              disabled={disabled}
              label="Sampling mode"
              type="select"
              value={draft.autosave.samplingMode}
              onChange={(event) =>
                props.onUpdateDraft({
                  autosave: {
                    ...draft.autosave,
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
                disabled || draft.autosave.samplingMode === "auto_sinc_cutoff"
              }
              label="Every"
              min="0"
              type="number"
              unit="s"
              value={draft.autosave.everySeconds}
              onChange={(event) =>
                props.onUpdateDraft({
                  autosave: {
                    ...draft.autosave,
                    everySeconds: event.target.value,
                  },
                })
              }
            />
          </>
        ) : null}
        <FieldRow
          label="Effect"
          value={effectLabel(draft)}
        />
        {draft?.autosave.readOnly ? (
          <FeedbackBanner
            kind="warning"
            message="This imported output kind is unsupported by the editor. Its payload is preserved losslessly and remains read-only."
          />
        ) : null}
        {draft?.autosave.enabled ? (
          <SamplingDiagnostics durationS={durationS} sampling={effectiveOutput} />
        ) : null}
      </InspectorGroup>
    </>
  );
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function effectLabel(draft: StageInspectorFrameProps["draft"]): string {
  if (!draft || draft.kind !== "autosave") return "not available";
  if (draft.autosave.enabled) {
    return `enable or replace ${draft.autosave.quantity} for every following Run`;
  }
  if (draft.autosave.clearAll) {
    return "disable every active periodic field/scalar output for following Run stages";
  }
  return `disable ${draft.autosave.quantity} while preserving other outputs`;
}
