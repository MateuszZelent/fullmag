"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function HysteresisStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="hysteresis"
        kindLabel="Hysteresis"
      />
      <InspectorSection
        value="hysteresis-sweep"
        title="Field Sweep"
        badge={`${draft?.fieldSteps ?? "n/a"} steps`}
      >
        <FieldRow label="Start field" value={draft?.startField ?? "not set"} />
        <FieldRow label="Stop field" value={draft?.stopField ?? "not set"} />
        <FieldRow label="Field steps" value={draft?.fieldSteps ?? "not set"} />
      </InspectorSection>
      <InspectorSection value="hysteresis-relaxation" title="Per-Point Relaxation">
        <FieldRow
          label="Torque tolerance"
          value={stage?.torqueToleranceFormatted ?? draft?.torqueTolerance ?? "not set"}
        />
        <FieldRow label="Relax algorithm" value={draft?.algorithm || "runtime default"} />
        <FieldRow label="Max steps" value={draft?.maxSteps || "runtime default"} />
      </InspectorSection>
      <InspectorSection value="hysteresis-results" title="Hysteresis Results">
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow
          label="Progress metric"
          value={stage?.runtimeMetric?.name ?? "not available"}
        />
        <FieldRow
          label="Current loop metric"
          value={stage?.runtimeMetric?.value ?? "not available"}
        />
        <FieldRow
          label="Artifacts"
          value={stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"}
        />
      </InspectorSection>
    </>
  );
}
