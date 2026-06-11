"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import { displayValue, isRecord } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisProtocolInspector({
  draft,
  protocol,
}: Pick<HysteresisInspectorCommonProps, "draft" | "protocol">) {
  const saturation = isRecord(protocol?.saturation) ? protocol.saturation : null;
  const storage = isRecord(protocol?.storage) ? protocol.storage : null;

  return (
    <InspectorSection
      value="hysteresis-protocol"
      title="Protocol"
      badge={protocol?.initial_protocol ?? draft?.initialStatePolicy ?? "as_authored"}
    >
      <FieldRow label="Protocol kind" value={protocol?.branch_mode ?? draft?.protocolKind ?? "n/a"} />
      <FieldRow
        label="Initial state"
        value={protocol?.initial_protocol ?? draft?.initialStatePolicy ?? "n/a"}
      />
      <FieldRow label="Branch mode" value={protocol?.branch_mode ?? draft?.protocolKind ?? "n/a"} />
      <FieldRow label="Measurement axis" value={draft?.measurementAxis ?? "n/a"} />
      <FieldRow
        label="Saturation mode"
        value={displayValue(saturation?.mode) ?? draft?.saturationMode ?? "n/a"}
      />
      <FieldRow
        label="Storage"
        value={displayValue(storage?.magnetization) ?? "n/a"}
      />
      <FieldRow label="Settle pipeline" value={draft?.settlePipelineMode ?? "n/a"} />
    </InspectorSection>
  );
}
