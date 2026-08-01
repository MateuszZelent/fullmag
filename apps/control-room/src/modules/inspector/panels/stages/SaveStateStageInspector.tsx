"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function SaveStateStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="save_state"
        kindLabel="Save State"
      />
      <InspectorGroup
        title="Output Target"
        badge={draft?.artifactName || "artifact"}
      >
        <FieldRow
          label="Artifact"
          value={draft?.artifactName ?? "not set"}
        />
        <FieldRow label="Format" value={draft?.format || "default"} />
        <FieldRow label="Dataset" value={draft?.dataset || "default"} />
      </InspectorGroup>
      <InspectorGroup title="Captured State">
        <FieldRow label="Source" value="current runtime magnetization" />
        <FieldRow label="Checkpoint link" value={stage?.checkpointRef ?? "not linked"} />
        <FieldRow
          label="Artifact refs"
          value={stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"}
        />
      </InspectorGroup>
      <InspectorGroup title="Save Results">
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow
          label="Saved"
          value={stage?.status === "completed" ? "yes" : "not yet"}
        />
        <FieldRow
          label="Completed"
          value={stage?.completedAtIso ?? "not completed"}
        />
      </InspectorGroup>
    </>
  );
}
