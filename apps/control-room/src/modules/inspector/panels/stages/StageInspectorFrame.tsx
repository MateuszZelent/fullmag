"use client";

import { Save } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../primitives/FieldRow";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  StudyStageDraftEditor,
} from "../StudyPipelineSection";
import type { StudyStageDraft } from "../StudyStageAuthoringModel";
import type { StudyStageModel } from "../StudyInspectorPanelModel";

export interface StageInspectorFrameProps {
  authoringBusy: boolean;
  authoringFeedback: {
    kind: "error" | "success" | "warning";
    message: string;
  } | null;
  draft: StudyStageDraft | null;
  draftIndex: number;
  expectedKind: string;
  kindLabel: string;
  onCommit: () => void;
  onUpdateDraft: (patch: Partial<StudyStageDraft>) => void;
  stage: StudyStageModel | null;
  stageExecutionRevision: number | null;
  validation: readonly { message: string; severity: "error" | "warning" }[];
}

export function StageInspectorFrame({
  authoringBusy,
  authoringFeedback,
  draft,
  draftIndex,
  expectedKind,
  kindLabel,
  onCommit,
  onUpdateDraft,
  stage,
  stageExecutionRevision,
  validation,
}: StageInspectorFrameProps) {
  const hasDraftErrors = validation.some((issue) => issue.severity === "error");
  const isExpectedDraft = draft?.kind === expectedKind;

  return (
    <>
      <InspectorSection
        value="identity"
        title="Identity"
        badge={stage?.status ?? "not selected"}
      >
        <FieldRow label="Stage" value={stage?.label ?? kindLabel} />
        <FieldRow label="Kind" value={stage?.kind ?? expectedKind} />
        <FieldRow label="Stage ID" value={stage?.stageId ?? draft?.stageId ?? "n/a"} />
        <FieldRow label="Status" value={stage?.status ?? "draft"} />
        <FieldRow
          label="Execution revision"
          value={stageExecutionRevision ?? "not available"}
        />
      </InspectorSection>

      <InspectorSection value="authoring" title="Authoring" badge={kindLabel}>
        {draft && isExpectedDraft ? (
          <StudyStageDraftEditor
            draft={draft}
            index={draftIndex}
            validation={validation}
            onUpdate={onUpdateDraft}
          />
        ) : (
          <div className="fm-study-stage-empty">
            Selected tree node does not match the current study draft.
          </div>
        )}
        {authoringFeedback ? (
          <FeedbackBanner
            kind={authoringFeedback.kind}
            message={authoringFeedback.message}
          />
        ) : null}
        <div className="fm-inspector-toolbar">
          <Button
            disabled={authoringBusy || hasDraftErrors || !draft || !isExpectedDraft}
            size="sm"
            type="button"
            variant="primary"
            onClick={onCommit}
          >
            <Save size={13} aria-hidden="true" />
            {authoringBusy ? "Saving" : "Save stage"}
          </Button>
        </div>
      </InspectorSection>

      <InspectorSection
        value="telemetry"
        title="Telemetry & Results"
        badge={stage?.runtimeMetric?.name ?? "stage"}
      >
        <FieldRow label="Progress" value={`${stage?.progressPercent ?? 0}%`} />
        <FieldRow
          label="Metric"
          value={stage?.runtimeMetric?.value ?? "not available"}
        />
        <FieldRow
          label="Target"
          value={stage?.runtimeMetric?.threshold ?? "not available"}
        />
        <FieldRow label="Stop reason" value={stage?.stopReason ?? "not available"} />
        <FieldRow
          label="Checkpoint"
          value={stage?.checkpointRef ?? "not available"}
        />
        <FieldRow
          label="Artifacts"
          value={
            stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"
          }
        />
      </InspectorSection>
    </>
  );
}
