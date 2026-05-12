"use client";

import {
  Activity,
  Pause,
  Play,
  Plus,
  SkipForward,
  Square,
  Zap,
} from "lucide-react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useCurrentRunResource,
  useSolverEnergyCurrentResource,
  useSolverEnergyHistoryResource,
  useSolverStatusResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

import {
  resolveStudyInspectorModel,
  studySnapshotFromScene,
  type StudyStageModel,
} from "./StudyInspectorPanelModel";

function ProgressBar({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  const pct = value ?? 0;
  return (
    <div
      className="fm-study-progress"
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value ?? undefined}
      role="progressbar"
    >
      <span className="fm-study-progress__bar" style={{ width: `${pct}%` }} />
      <span className="fm-study-progress__label">
        {value == null ? "pending" : `${pct}%`}
      </span>
    </div>
  );
}

function StageCard({
  active,
  stage,
}: {
  active: boolean;
  stage: StudyStageModel;
}) {
  return (
    <div
      className="fm-study-stage-card"
      data-active={active ? "true" : undefined}
      data-status={stage.status}
    >
      <div className="fm-study-stage-card__header">
        <span>{stage.label}</span>
        <small>{stage.status}</small>
      </div>
      <ProgressBar
        label={`${stage.label} progress`}
        value={stage.progressPercent}
      />
      <div className="fm-study-stage-card__meta">
        {stage.torqueTolerance ? <span>tau {stage.torqueTolerance}</span> : null}
        {stage.energyTolerance ? <span>E {stage.energyTolerance}</span> : null}
        {stage.maxSteps ? <span>{stage.maxSteps} steps</span> : null}
        {stage.untilSeconds ? <span>{stage.untilSeconds} s</span> : null}
      </div>
    </div>
  );
}

export function StudyInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const currentRun = useCurrentRunResource();
  const stageExecution = useStageExecutionResource();
  const solverStatus = useSolverStatusResource();
  const energyCurrent = useSolverEnergyCurrentResource();
  const energyHistory = useSolverEnergyHistoryResource(120);
  const snapshot = studySnapshotFromScene(scene.data);
  const model = resolveStudyInspectorModel({
    currentRun: currentRun.data,
    selectedNodeId: selection.nodeId,
    snapshot,
    solverStatus: solverStatus.data,
    stageExecution: stageExecution.data,
  });
  const activeStageIndex = stageExecution.data?.active_stage_index ?? null;
  const commandContext = createCommandContext("ribbon", kernel);
  const runCommand = (commandId: string) => {
    void kernel.commands.execute(commandId, commandContext);
  };
  const commandEnabled = (commandId: string) =>
    kernel.commands.isEnabled(commandId, commandContext);

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Runtime" badge={model.runtime.state}>
        <FieldRow label="Run" value={model.runtime.runId} />
        <FieldRow label="Active stage" value={model.runtime.activeStageLabel} />
        <FieldRow label="Max torque" value={model.runtime.maxTorque} />
        <FieldRow
          label="Step"
          value={solverStatus.data?.step_index ?? currentRun.data?.total_steps ?? "n/a"}
        />
        <ProgressBar
          label="Current study progress"
          value={model.runtime.progressPercent}
        />
        <div className="fm-inspector-toolbar">
          <Button
            size="sm"
            type="button"
            disabled={!commandEnabled("study.run")}
            onClick={() => runCommand("study.run")}
          >
            <Play size={13} />
            Compute
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={!commandEnabled("study.pause")}
            onClick={() => runCommand("study.pause")}
          >
            <Pause size={13} />
            Pause
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={!commandEnabled("study.resume")}
            onClick={() => runCommand("study.resume")}
          >
            <Play size={13} />
            Resume
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={!commandEnabled("study.skip")}
            onClick={() => runCommand("study.skip")}
          >
            <SkipForward size={13} />
            Skip
          </Button>
          <Button
            size="sm"
            type="button"
            variant="danger"
            disabled={!commandEnabled("study.stop")}
            onClick={() => runCommand("study.stop")}
          >
            <Square size={13} />
            Stop
          </Button>
        </div>
      </InspectorSection>

      <InspectorSection title="Selected Stage" badge={model.selectedStage?.status ?? "none"}>
        <FieldRow label="Kind" value={model.selectedStage?.kind ?? "none"} />
        <FieldRow
          label="Torque stop"
          value={model.selectedStage?.torqueTolerance ?? "not set"}
        />
        <FieldRow
          label="Energy stop"
          value={model.selectedStage?.energyTolerance ?? "not set"}
        />
        <FieldRow
          label="Step budget"
          value={model.selectedStage?.maxSteps ?? "not set"}
        />
        <FieldRow
          label="Time budget"
          value={model.selectedStage?.untilSeconds ?? "not set"}
          unit={model.selectedStage?.untilSeconds ? "s" : undefined}
        />
        <ProgressBar
          label="Selected stage progress"
          value={model.selectedStage?.progressPercent ?? null}
        />
      </InspectorSection>

      <InspectorSection title="Boundary Conditions" badge={snapshot.requested.backend}>
        <FieldRow
          label="Demag realization"
          value={model.boundary.demagRealization}
        />
        <FieldRow label="External field" value={model.boundary.externalField} />
        <FieldRow label="Device" value={snapshot.requested.device} />
        <FieldRow label="Precision" value={snapshot.requested.precision} />
        <FieldRow label="Mode" value={snapshot.requested.mode} />
      </InspectorSection>

      <InspectorSection title="Stage Pipeline" badge={`${model.stages.length}`}>
        <div className="fm-study-stage-list">
          {model.stages.map((stage) => (
            <StageCard
              key={stage.index}
              active={activeStageIndex === stage.index}
              stage={stage}
            />
          ))}
        </div>
        <div className="fm-inspector-toolbar">
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={!commandEnabled("study.add-relax-stage")}
            onClick={() => runCommand("study.add-relax-stage")}
          >
            <Plus size={13} />
            Relax
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={!commandEnabled("study.add-run-stage")}
            onClick={() => runCommand("study.add-run-stage")}
          >
            <Zap size={13} />
            Run
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={!commandEnabled("study.compute-fields")}
            onClick={() => runCommand("study.compute-fields")}
          >
            <Activity size={13} />
            Fields
          </Button>
        </div>
      </InspectorSection>

      <InspectorSection title="Run History" badge={`${energyHistory.data?.returned_rows ?? 0}`}>
        <FieldRow
          label="Energy step"
          value={energyCurrent.data?.step ?? "not available"}
        />
        <FieldRow
          label="Total energy"
          value={
            typeof energyCurrent.data?.total === "number"
              ? energyCurrent.data.total.toExponential(4)
              : "not available"
          }
          unit="J"
        />
        <FieldRow
          label="Returned rows"
          value={energyHistory.data?.returned_rows ?? "not available"}
        />
        <FieldRow
          label="Total rows"
          value={energyHistory.data?.total_rows ?? "not available"}
        />
      </InspectorSection>
    </div>
  );
}
