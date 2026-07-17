"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { regionalFieldDriveSamplingContext } from "../RegionalFieldDrivePanelModel";
import { StudyProgressBar } from "../StudyProgressBar";
import type { StudyStageDraft } from "../StudyStageAuthoringModel";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import { SamplingDiagnostics } from "./SamplingDiagnostics";
import { formatEngineering } from "./samplingPresentation";
import { resolveStudyWorkflowStateBefore } from "./studyWorkflowState";

export function RunStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft?.kind === "run" ? props.draft : null;
  const stage = props.stage;
  const workflow = resolveStudyWorkflowStateBefore(
    props.pipelineDrafts ?? [],
    props.draftIndex,
  );
  const durationS = positiveNumber(draft?.untilSeconds);
  const samplePeriodS = workflow.tableAutosave?.samplePeriodS ?? null;
  const solverDtS = regionalFieldDriveSamplingContext(
    props.scene ?? null,
    null,
  ).solverDtS;
  const precedingDriveDraft = findPrecedingActiveDrive(
    props.pipelineDrafts ?? [],
    props.draftIndex,
    draft?.stageId ?? null,
  );

  return (
    <>
      <StageInspectorFrame {...props} expectedKind="run" kindLabel="Run" />
      <InspectorGroup
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
      </InspectorGroup>

      <InspectorGroup
        title="Time Integration"
        badge={stage?.status ?? "draft"}
      >
        <FieldRow
          label="Instruction"
          value="advance the configured LLG time solver until the authored time"
        />
        <FieldRow
          label="Initial state"
          value="complete state produced by the preceding workflow instruction"
        />
        <FieldRow
          label="Until"
          value={durationS ? formatEngineering(durationS, "s") : "not declared"}
        />
        <FieldRow
          label="Solver and integration dt"
          value={
            solverDtS
              ? `${formatEngineering(solverDtS, "s")} — configured in the global Solver definition`
              : "configured independently in the global Solver definition"
          }
        />
        <FieldRow label="Dynamics" value="full LLG time evolution" />
      </InspectorGroup>

      <InspectorGroup title="Drive & Dynamics">
        <FieldRow label="Start state" value="current magnetization state" />
        <FieldRow
          label="Active antenna"
          value={precedingDriveDraft?.fieldDrive.name ?? "no active preceding drive"}
        />
        <FieldRow
          label="Field evaluation"
          value="all currently active drives are evaluated by the time solver"
        />
      </InspectorGroup>

      <InspectorGroup
        title="Active Autosave & FFT State"
        badge={workflow.tableAutosave ? "sampling enabled" : "sampling disabled"}
      >
        <FieldRow
          label="Table autosave"
          value={workflow.tableAutosave ? "ON" : "OFF"}
        />
        <FieldRow
          label="t_sampling source"
          value={workflow.tableAutosave?.sourceStageId ?? "no preceding ON stage"}
        />
        <FieldRow
          label="t_sampling"
          value={samplePeriodS ? formatEngineering(samplePeriodS, "s") : "not declared"}
        />
        <FieldRow
          label="Table quantities"
          value={workflow.tableAutosave?.quantities.join(", ") || "none"}
        />
        <FieldRow
          label="Autosave outputs"
          value={
            workflow.outputs.length
              ? workflow.outputs
                  .map(
                    (output) =>
                      `${output.quantity} ${
                        output.everySeconds
                          ? `every ${formatEngineering(output.everySeconds, "s")}`
                          : "with unresolved cadence"
                      } (${output.sourceStageId})`,
                  )
                  .join("; ")
              : "none — this Run advances without periodic field/scalar files"
          }
        />
        <FieldRow
          label="FFT response"
          value={
            workflow.fftResponse
              ? `ON: ${workflow.fftResponse.responseComponent}, ${workflow.fftResponse.window}, source ${workflow.fftResponse.sourceStageId}`
              : "OFF"
          }
        />
        <SamplingDiagnostics
          durationS={durationS}
          sampling={workflow.tableAutosave}
        />
        {workflow.fftResponse && !workflow.tableAutosave ? (
          <FeedbackBanner
            kind="warning"
            message="FFT response is ON, but no preceding Table autosave ON stage defines t_sampling. Add or enable that workflow instruction before this Run."
          />
        ) : null}
        <p className="fm-sinc-preview__message fm-sinc-preview__message--ready">
          Effective state is resolved strictly from preceding workflow stages. This Run does not own or silently modify autosave, table sampling, or FFT analysis.
        </p>
      </InspectorGroup>

      <InspectorGroup title="Run Results">
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
      </InspectorGroup>
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

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
