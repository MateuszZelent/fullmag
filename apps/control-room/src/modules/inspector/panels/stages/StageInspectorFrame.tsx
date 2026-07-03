"use client";

import { Save } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../primitives/FieldRow";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StudyProgressBar } from "../StudyProgressBar";
import {
  StudyStageDraftEditor,
} from "../StudyPipelineSection";
import type { StudyStageDraft } from "../StudyStageAuthoringModel";
import type { StudyStageModel } from "../StudyInspectorPanelModel";

export type FrequencyDomainAuthoringView =
  | "calculation_mode"
  | "overview"
  | "setup"
  | "equilibrium"
  | "operator"
  | "boundary"
  | "periodic_pairs"
  | "k_sampling"
  | "k_path"
  | "k_grid"
  | "excitation"
  | "sweep"
  | "solver"
  | "outputs"
  | "diagnostics";

export interface StageInspectorFrameProps {
  authoringView?: FrequencyDomainAuthoringView;
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
  runRuntimeCommand?: (commandId: string, input?: unknown) => void;
  runtimeCommandDisabledReason?: (commandId: string) => string | null;
  stage: StudyStageModel | null;
  stageExecutionRevision: number | null;
  validation: readonly { message: string; severity: "error" | "warning" }[];
}

export function StageInspectorFrame({
  authoringView = "overview",
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
  const stageKind = (stage?.kind ?? expectedKind).toLowerCase();
  const stageStatus = (stage?.status ?? "draft").toLowerCase();
  const activeStageStatuses = [
    "accepted",
    "dispatched",
    "materializing",
    "pending",
    "queued",
    "running",
  ];
  const eigenmodeSolving =
    stageKind.includes("eigen") && activeStageStatuses.includes(stageStatus);
  const frequencyResponseSolving =
    stageKind.includes("frequency_response") &&
    activeStageStatuses.includes(stageStatus);
  const hasStageProgress =
    stage !== null &&
    (stage.progressLabel != null ||
      stage.progressDetail != null ||
      stage.progressPercent > 0);
  const stageProgressValue =
    (eigenmodeSolving || frequencyResponseSolving) && !hasStageProgress
      ? null
      : (stage?.progressPercent ?? null);
  const stageProgressLabel =
    stage?.progressLabel ??
    (eigenmodeSolving
      ? "stage running; per-iteration modal telemetry pending"
      : frequencyResponseSolving
        ? "stage running; per-frequency sweep telemetry pending"
        : undefined);
  const eigenmodeActivity = eigenmodeSolving
    ? summarizeEigenmodeActivity({
        hasStageProgress,
        stage,
        stageExecutionRevision,
      })
    : null;
  const frequencyResponseActivity = frequencyResponseSolving
    ? summarizeFrequencyResponseActivity({
        hasStageProgress,
        stage,
        stageExecutionRevision,
      })
    : null;

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
            view={authoringView}
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
            disabled={authoringBusy || hasDraftErrors || !draft || !isExpectedDraft || draft.kind === "eigenmodes" || draft.kind === "frequency_response"}
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
        {eigenmodeSolving ? (
          <>
            <FieldRow
              label="Eigenmode solve progress"
              value={stageProgressLabel}
            />
            <FieldRow
              label="Solver activity"
              value={eigenmodeActivity?.activity ?? "not available"}
            />
            <FieldRow
              label="Progress source"
              value={eigenmodeActivity?.source ?? "not available"}
            />
            <FieldRow
              label="Stage started"
              value={formatUnixMs(stage?.startedAtUnixMs)}
            />
            <FieldRow
              label="Last solver update"
              value={formatUnixMs(stage?.lastProgressUnixMs)}
            />
            <FieldRow
              label="Command ID"
              value={stage?.commandId ?? "not available"}
            />
          </>
        ) : null}
        {frequencyResponseSolving ? (
          <>
            <FieldRow
              label="Frequency response sweep progress"
              value={stageProgressLabel}
            />
            <FieldRow
              label="Sweep activity"
              value={frequencyResponseActivity?.activity ?? "not available"}
            />
            <FieldRow
              label="Progress source"
              value={frequencyResponseActivity?.source ?? "not available"}
            />
            <FieldRow
              label="Stage started"
              value={formatUnixMs(stage?.startedAtUnixMs)}
            />
            <FieldRow
              label="Last solver update"
              value={formatUnixMs(stage?.lastProgressUnixMs)}
            />
            <FieldRow
              label="Command ID"
              value={stage?.commandId ?? "not available"}
            />
          </>
        ) : null}
        <StudyProgressBar
          indeterminate={
            (eigenmodeSolving || frequencyResponseSolving) && !hasStageProgress
          }
          label={
            eigenmodeSolving
              ? "Eigenmode solve progress"
              : frequencyResponseSolving
                ? "Frequency response sweep progress"
              : "Selected stage progress"
          }
          statusLabel={stage?.progressLabel ?? undefined}
          value={stageProgressValue}
        />
        {stage?.progressDetail ? (
          <FieldRow label="Progress detail" value={stage.progressDetail} />
        ) : null}
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

function summarizeEigenmodeActivity({
  hasStageProgress,
  stage,
  stageExecutionRevision,
}: {
  hasStageProgress: boolean;
  stage: StudyStageModel | null;
  stageExecutionRevision: number | null;
}) {
  const status = stage?.status ?? "draft";
  const detail = stage?.progressDetail ?? stage?.progressLabel ?? null;
  return {
    activity: hasStageProgress
      ? `${status}; ${detail ?? "solver progress telemetry published"}`
      : `${status}; solver stage is active; no modal iteration counter published yet`,
    source: `simulation/stages/execution@${stageExecutionRevision ?? "unknown"}; ${
      hasStageProgress ? "progress telemetry observed" : "stage lifecycle observed"
    }`,
  };
}

function summarizeFrequencyResponseActivity({
  hasStageProgress,
  stage,
  stageExecutionRevision,
}: {
  hasStageProgress: boolean;
  stage: StudyStageModel | null;
  stageExecutionRevision: number | null;
}) {
  const status = stage?.status ?? "draft";
  const detail = stage?.progressDetail ?? stage?.progressLabel ?? null;
  return {
    activity: hasStageProgress
      ? `${status}; ${detail ?? "frequency sweep progress telemetry published"}`
      : `${status}; response sweep is active; no per-frequency counter published yet`,
    source: `simulation/stages/execution@${stageExecutionRevision ?? "unknown"}; ${
      hasStageProgress ? "progress telemetry observed" : "stage lifecycle observed"
    }`,
  };
}

function formatUnixMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "not published";
  return new Date(value).toISOString();
}
