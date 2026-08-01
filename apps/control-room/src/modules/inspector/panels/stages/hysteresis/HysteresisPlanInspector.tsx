"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import { isRecord, parseJsonArray, parseJsonRecord } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisPlanInspector({
  adaptiveRefinement,
  draft,
  stagePlan,
}: Pick<HysteresisInspectorCommonProps, "adaptiveRefinement" | "draft" | "stagePlan">) {
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
  const fieldUnitProvenance = stagePlan?.field_unit_provenance ?? null;
  const authoredFieldUnit = fieldUnitProvenance
    ? `${fieldUnitProvenance.authored_quantity} (${fieldUnitProvenance.authored_unit})`
    : null;
  const canonicalFieldUnit = fieldUnitProvenance
    ? `${fieldUnitProvenance.canonical_quantity} (${fieldUnitProvenance.canonical_unit})`
    : null;

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
  const storageEstimate = stagePlan?.storage_estimate ?? null;
  const storageEstimateSummary = storageEstimate
    ? [
        storageEstimate.status,
        `${storageEstimate.point_count ?? "?"} point(s)`,
        `${storageEstimate.snapshot_count ?? "?"} snapshot(s)`,
        formatStorageBytes(storageEstimate.estimated_bytes),
      ].join(" | ")
    : "pending";
  const storageWarnings = storageEstimate?.warnings?.filter(Boolean) ?? [];
  const adaptiveCandidateCount = adaptiveRefinement?.candidates?.length ?? 0;
  const adaptivePointCount = adaptiveRefinement?.points?.length ?? 0;
  const adaptiveStatus = adaptiveRefinement
    ? `${adaptiveRefinement.status} | ${adaptiveCandidateCount} candidate(s) | ${adaptivePointCount} computed point(s)`
    : stagePlan?.adaptive_refinement
      ? "configured, awaiting runtime artifact"
      : "not configured";

  return (
    <InspectorGroup
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
      {fieldUnitProvenance && (
        <>
          <FieldRow label="Authored field" value={authoredFieldUnit} />
          <FieldRow label="Canonical field" value={canonicalFieldUnit} />
          <FieldRow
            label="mu0"
            value={fieldUnitProvenance.mu0_h_per_m.toExponential(12)}
            unit="H/m"
          />
        </>
      )}
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
      <FieldRow label="Storage estimate" value={storageEstimateSummary} />
      {storageWarnings.length > 0 && (
        <FieldRow label="Storage warnings" value={storageWarnings.join("; ")} />
      )}
      <FieldRow label="Adaptive refinement" value={adaptiveStatus} />
    </InspectorGroup>
  );
}

function formatStorageBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
    return "size pending";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
