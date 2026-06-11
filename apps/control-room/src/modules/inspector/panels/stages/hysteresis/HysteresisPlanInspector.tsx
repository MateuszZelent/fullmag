"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import { isRecord, parseJsonArray, parseJsonRecord } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisPlanInspector({
  draft,
  stagePlan,
}: Pick<HysteresisInspectorCommonProps, "draft" | "stagePlan">) {
  const fieldSchedule = isRecord(stagePlan?.field_schedule)
    ? stagePlan.field_schedule
    : null;
  const scheduledSegments = Array.isArray(fieldSchedule?.segments)
    ? fieldSchedule.segments.filter(isRecord)
    : [];
  const minorLoops = Array.isArray(stagePlan?.minor_loops)
    ? stagePlan.minor_loops.filter(isRecord)
    : parseJsonArray(draft?.minorLoops);
  const fieldSegments = scheduledSegments.length > 0
    ? scheduledSegments
    : parseJsonArray(draft?.fieldSegments);
  const scheduleMode = stagePlan?.field_values_mT
    ? "explicit_values"
    : fieldSegments.length > 0
      ? "piecewise"
      : draft?.fieldScheduleMode;
  const fieldMinMt = stagePlan?.field_min_mT ?? draft?.fieldMinMt;
  const fieldMaxMt = stagePlan?.field_max_mT ?? draft?.fieldMaxMt;
  const fieldStepMt = stagePlan?.field_step_mT ?? draft?.fieldStepMt;

  let storagePolicyFormatted = "average only";
  const policy = parseJsonRecord(draft?.storagePolicy);
  if (policy) {
    if (policy.magnetization === "all" || policy.magnetization === "every_step") {
      storagePolicyFormatted = "every step";
    } else if (policy.magnetization === "selected") {
      storagePolicyFormatted = `selected (every ${policy.every_n ?? 5} steps)`;
    } else if (policy.magnetization === "key_events") {
      storagePolicyFormatted = `key events (threshold ${policy.key_event_threshold_dm ?? 0.02})`;
    } else if (policy.magnetization === "none") {
      storagePolicyFormatted = "scalar averages only";
    }
  }

  return (
    <InspectorSection
      value="hysteresis-plan"
      title="Measurement Plan"
      badge={stagePlan?.branch_mode ?? draft?.protocolKind ?? "major_loop"}
    >
      <FieldRow label="Protocol" value={stagePlan?.branch_mode ?? draft?.protocolKind ?? "n/a"} />
      <FieldRow label="Initial state" value={draft?.initialStatePolicy ?? "n/a"} />
      <FieldRow label="Orientation mode" value={draft?.orientationMode ?? "n/a"} />
      {draft?.orientationMode === "sample" && (
        <FieldRow
          label="Sample angles"
          value={`theta = ${draft?.thetaDeg ?? "0"} deg, phi = ${draft?.phiDeg ?? "0"} deg`}
        />
      )}
      {draft?.orientationMode === "global" && (
        <FieldRow label="Direction vector" value={draft?.customDirection ?? "n/a"} />
      )}
      <FieldRow label="Measurement axis" value={draft?.measurementAxis ?? "n/a"} />
      <FieldRow label="Schedule mode" value={scheduleMode ?? "n/a"} />
      {scheduleMode !== "piecewise" ? (
        <>
          <FieldRow label="Minimum field" value={fieldMinMt ?? "n/a"} unit="mT" />
          <FieldRow label="Maximum field" value={fieldMaxMt ?? "n/a"} unit="mT" />
          <FieldRow label="Field step" value={fieldStepMt ?? "n/a"} unit="mT" />
        </>
      ) : (
        <FieldRow label="Segments" value={`${fieldSegments.length} segment(s) defined`} />
      )}
      {minorLoops.length > 0 && (
        <FieldRow label="Minor loops" value={`${minorLoops.length} loop(s) configured`} />
      )}
      <FieldRow label="Storage policy" value={storagePolicyFormatted} />
    </InspectorSection>
  );
}
