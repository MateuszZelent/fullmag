"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function ChangeDeviceStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  const transition = stage?.transition;

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="change_device"
        kindLabel="Change Device"
      />
      <InspectorGroup
        title="Execution Device"
        badge={draft?.deviceTarget || "device"}
      >
        <FieldRow label="Requested device" value={draft?.deviceTarget ?? "not set"} />
        <FieldRow label="Python DSL" value={`study.stages.change_device("${draft?.deviceTarget ?? "cpu"}")`} />
        <FieldRow label="Transfer operator" value={transition?.transferOperator ?? "identity_copy"} />
      </InspectorGroup>
      <InspectorGroup title="Runtime Boundary">
        <FieldRow label="State transition" value={transition?.label ?? "Change device"} />
        <FieldRow label="Transition kind" value={transition?.kind ?? "backend_transfer"} />
        <FieldRow label="Transition reason" value={transition?.reason ?? "device_change"} />
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
      </InspectorGroup>
    </>
  );
}
