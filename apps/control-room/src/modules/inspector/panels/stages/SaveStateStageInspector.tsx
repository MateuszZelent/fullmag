"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function SaveStateStageInspector(props: StageInspectorFrameProps) {
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="save_state"
        kindLabel="Save State"
      />
      <InspectorSection value="save-state-results" title="Output Settings">
        <FieldRow
          label="Artifact"
          value={props.draft?.artifactName ?? "not set"}
        />
        <FieldRow label="Format" value={props.draft?.format || "default"} />
        <FieldRow label="Dataset" value={props.draft?.dataset || "default"} />
        <FieldRow
          label="Saved"
          value={props.stage?.status === "completed" ? "yes" : "not yet"}
        />
      </InspectorSection>
    </>
  );
}
