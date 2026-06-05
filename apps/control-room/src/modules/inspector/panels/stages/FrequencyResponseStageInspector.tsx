"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function FrequencyResponseStageInspector(props: StageInspectorFrameProps) {
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="frequency_response"
        kindLabel="Frequency Response"
      />
      <InspectorSection value="frequency-response-results" title="Frequency Results">
        <FieldRow
          label="Frequencies"
          value={props.draft?.frequenciesHz ?? "not set"}
        />
        <FieldRow
          label="Excitation"
          value={props.draft?.excitationField ?? "not set"}
        />
        <FieldRow
          label="Observable"
          value={props.draft?.observable ?? "not set"}
        />
        <FieldRow
          label="Computed response"
          value={props.stage?.runtimeMetric?.value ?? "not available"}
        />
      </InspectorSection>
    </>
  );
}
