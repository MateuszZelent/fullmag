"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function EigenmodesStageInspector(props: StageInspectorFrameProps) {
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="eigenmodes"
        kindLabel="Eigenmodes"
      />
      <InspectorSection value="eigenmodes-results" title="Eigenmode Results">
        <FieldRow label="Mode count" value={props.draft?.count ?? "not set"} />
        <FieldRow
          label="Target"
          value={props.draft?.target ?? "not set"}
        />
        <FieldRow
          label="Target frequency"
          value={props.draft?.targetFrequency || "not set"}
        />
        <FieldRow label="k vector" value={props.draft?.kVector || "not set"} />
        <FieldRow
          label="Computed modes"
          value={props.stage?.runtimeMetric?.value ?? "not available"}
        />
      </InspectorSection>
    </>
  );
}
