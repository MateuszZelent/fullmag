"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function RelaxStageInspector(props: StageInspectorFrameProps) {
  return (
    <>
      <StageInspectorFrame {...props} expectedKind="relax" kindLabel="Relax" />
      <InspectorSection value="relax-results" title="Relax Results">
        <FieldRow
          label="Torque tolerance"
          value={props.stage?.torqueToleranceFormatted ?? "not set"}
        />
        <FieldRow
          label="Energy tolerance"
          value={props.stage?.energyTolerance ?? "not set"}
        />
        <FieldRow label="Max steps" value={props.stage?.maxSteps ?? "not set"} />
        <FieldRow
          label="Elapsed time"
          value={props.stage?.runtimeMetric?.value ?? "not available"}
        />
      </InspectorSection>
    </>
  );
}
