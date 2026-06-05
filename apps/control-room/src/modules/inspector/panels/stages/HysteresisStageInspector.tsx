"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function HysteresisStageInspector(props: StageInspectorFrameProps) {
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="hysteresis"
        kindLabel="Hysteresis"
      />
      <InspectorSection value="hysteresis-results" title="Hysteresis Results">
        <FieldRow label="Start field" value={props.draft?.startField ?? "not set"} />
        <FieldRow label="Stop field" value={props.draft?.stopField ?? "not set"} />
        <FieldRow label="Field steps" value={props.draft?.fieldSteps ?? "not set"} />
        <FieldRow
          label="Current loop metric"
          value={props.stage?.runtimeMetric?.value ?? "not available"}
        />
      </InspectorSection>
    </>
  );
}
