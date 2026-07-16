"use client";

import { resolveHalfOpenSamplingClock } from "@/shared/domain/physics/sincPulsePreview";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { regionalFieldDriveSamplingContext } from "../RegionalFieldDrivePanelModel";
import { StudyProgressBar } from "../StudyProgressBar";
import type { StudyStageDraft } from "../StudyStageAuthoringModel";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import { SamplingDiagnostics } from "./SamplingDiagnostics";
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
  const samplingClock = durationS && samplePeriodS
    ? resolveHalfOpenSamplingClock(durationS, samplePeriodS)
    : null;
  const precedingDriveDraft = findPrecedingActiveDrive(
    props.pipelineDrafts ?? [],
    props.draftIndex,
    draft?.stageId ?? null,
  );

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
          label="Instruction"
          value="advance the configured LLG time solver until the authored time"
        />
        <FieldRow
          label="Initial state"
          value="complete state produced by the preceding workflow instruction"
        />
        <FieldRow
          label="Until"
          value={durationS ? engineering(durationS, "s") : "not declared"}
        />
        <FieldRow
          label="Solver and integration dt"
          value={
            solverDtS
              ? `${engineering(solverDtS, "s")} — configured in the global Solver definition`
              : "configured independently in the global Solver definition"
          }
        />
        <FieldRow label="Dynamics" value="full LLG time evolution" />
      </InspectorSection>

      <InspectorSection value="run-drive" title="Drive & Dynamics">
        <FieldRow label="Start state" value="current magnetization state" />
        <FieldRow
          label="Active antenna"
          value={precedingDriveDraft?.fieldDrive.name ?? "no active preceding drive"}
        />
        <FieldRow
          label="Field evaluation"
          value="all currently active drives are evaluated by the time solver"
        />
      </InspectorSection>

      <InspectorSection
        value="run-workflow-state"
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
          value={samplePeriodS ? engineering(samplePeriodS, "s") : "not declared"}
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
                          ? `every ${engineering(output.everySeconds, "s")}`
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
        <div
          className="fm-sinc-preview__metrics"
          role="list"
          aria-label="Effective response FFT parameters"
        >
          <Metric label="response dt (t_sampling)" value={samplePeriodS ? engineering(samplePeriodS, "s") : "not declared"} />
          <Metric label="samples N" value={samplingClock ? String(samplingClock.sampleCount) : "not available"} />
          <Metric label="duration" value={durationS ? engineering(durationS, "s") : "not declared"} />
          <Metric label="df" value={samplingClock ? engineering(samplingClock.frequencyResolutionHz, "Hz") : "not available"} />
          <Metric label="Nyquist" value={samplingClock ? engineering(samplingClock.nyquistHz, "Hz") : "not available"} />
        </div>
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
    [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m",
    0: "", 3: "k", 6: "M", 9: "G", 12: "T",
  };
  const prefix = prefixes[exponent];
  return prefix === undefined
    ? `${value.toExponential(3)} ${unit}`.trim()
    : `${(value / 10 ** exponent).toPrecision(4)} ${prefix}${unit}`.trim();
}
