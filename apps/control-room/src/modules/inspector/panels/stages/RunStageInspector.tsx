"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function RunStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  return (
    <>
      <StageInspectorFrame {...props} expectedKind="run" kindLabel="Run" />
      <InspectorSection
        value="run-time-integration"
        title="Time Integration"
        badge={stage?.status ?? "draft"}
      >
        <FieldRow
          label="Until"
          value={stage?.untilSeconds ?? draft?.untilSeconds ?? "not set"}
          unit={stage?.untilSeconds || draft?.untilSeconds ? "s" : undefined}
        />
        <FieldRow label="Integrator" value={draft?.solver || "runtime default"} />
        <FieldRow label="Fixed timestep" value={draft?.dt || "runtime default"} />
        <FieldRow label="Field refresh" value={draft?.fieldEvery || "not set"} />
      </InspectorSection>
      <InspectorSection value="run-drive" title="Drive & Dynamics">
        <FieldRow label="Start state" value="current magnetization state" />
        <FieldRow label="Dynamics" value="LLG time evolution" />
        <FieldRow label="Antenna fields" value="evaluated as time-dependent Zeeman masks" />
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
