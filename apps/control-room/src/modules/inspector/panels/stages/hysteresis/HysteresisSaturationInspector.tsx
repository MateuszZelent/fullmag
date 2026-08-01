"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisSaturationInspector({
  draft,
  metrics,
  saturation,
  saturationPoints,
}: Pick<
  HysteresisInspectorCommonProps,
  "draft" | "metrics" | "saturation" | "saturationPoints"
>) {
  const saturationNotice = hysteresisSaturationStatusNotice(metrics?.saturation_status ?? null);
  return (
    <InspectorGroup
      title="Auto-Saturation"
      badge={draft?.saturationMode || "none"}
    >
      <FieldRow label="Detection mode" value={draft?.saturationMode ?? "n/a"} />
      {draft?.saturationMode !== "none" && (
        <>
          <FieldRow label="Max probe field" value={draft?.maxProbeField ?? "n/a"} unit="mT" />
          <FieldRow label="Thresholds (dH, dM)" value={draft?.saturationThresholds ?? "n/a"} />
        </>
      )}
      <FieldRow
        label="Estimated Saturation Status"
        value={metrics?.saturation_status ?? "not available"}
      />
      {saturationNotice && (
        <FieldRow label={saturationNotice.label} value={saturationNotice.value} />
      )}
      {metrics?.saturation_preparation_field_mT != null && (
        <FieldRow
          label="Preparation Field"
          value={metrics.saturation_preparation_field_mT.toFixed(3)}
          unit="mT"
        />
      )}
      {saturation && (
        <>
          <FieldRow label="Probe result" value={saturation.status} />
          <FieldRow label="Probe reason" value={saturation.reason} />
          <FieldRow label="Probe points" value={String(saturationPoints.length)} />
        </>
      )}
    </InspectorGroup>
  );
}

function hysteresisSaturationStatusNotice(status: string | null) {
  if (status === "preparation_applied_unverified") {
    return {
      label: "Preparation field only",
      value:
        "H_sat is not confirmed; coercivity and remanence metrics have limited interpretation.",
    };
  }
  return null;
}
