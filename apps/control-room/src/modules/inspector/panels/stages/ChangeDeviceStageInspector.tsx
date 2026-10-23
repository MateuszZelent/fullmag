"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function ChangeDeviceStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  const transition = stage?.transition;
  const requestedDevice = draft?.deviceTarget.trim() || null;

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="change_device"
        kindLabel="Change Device"
      />
      <InspectorGroup
        title="Execution Device"
        badge={requestedDevice ?? "device"}
      >
        <FieldRow label="Requested device" value={requestedDevice ?? "not set"} />
        <FieldRow label="Python DSL" value={requestedDevice ? `study.stages.change_device(${JSON.stringify(requestedDevice.toLowerCase())})` : "not authored"} />
        <FieldRow label="Transfer operator" value={transition?.transferOperator ?? "not available"} />
      </InspectorGroup>
      <InspectorGroup title="Runtime Boundary">
        <FieldRow label="State transition" value={transition?.label ?? "not available"} />
        <FieldRow label="Transition kind" value={transition?.kind ?? "not available"} />
        <FieldRow label="Transition reason" value={transition?.reason ?? "not available"} />
        <FieldRow label="Status" value={stage?.status ?? "not available"} />
      </InspectorGroup>
    </>
  );
}
