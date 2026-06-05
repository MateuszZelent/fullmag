"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function RunStageInspector(props: StageInspectorFrameProps) {
  return (
    <>
      <StageInspectorFrame {...props} expectedKind="run" kindLabel="Run" />
      <InspectorSection value="run-results" title="Run Results">
        <FieldRow
          label="Until"
          value={props.stage?.untilSeconds ? `${props.stage.untilSeconds} s` : "not set"}
        />
        <FieldRow
          label="Elapsed"
          value={props.stage?.runtimeMetric?.value ?? "not available"}
        />
      </InspectorSection>
    </>
  );
}
