"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import { displayValue } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisOrientationInspector({
  draft,
  orientation,
  targetMetadata,
}: Pick<HysteresisInspectorCommonProps, "draft" | "orientation" | "targetMetadata">) {
  const direction = formatDirection(orientation?.direction);
  const resolvedOrientation =
    displayValue(targetMetadata.fieldOrientation) ??
    formatUnknown(orientation?.orientation) ??
    draftOrientation(draft);
  const measurementAxis =
    displayValue(targetMetadata.measurementAxis) ??
    formatUnknown(orientation?.measurement_axis) ??
    draft?.measurementAxis ??
    "field_axis";

  return (
    <InspectorGroup
      title="Field Orientation"
      badge={resolvedOrientation ?? "pending"}
    >
      <FieldRow label="Resolved orientation" value={resolvedOrientation ?? "n/a"} />
      <FieldRow label="Direction vector" value={direction ?? "n/a"} />
      <FieldRow label="Measurement axis" value={measurementAxis} />
      <FieldRow label="Runtime revision" value={orientation?.revision ?? "pending"} />
      <FieldRow label="Authored mode" value={draft?.orientationMode ?? "n/a"} />
      {draft?.orientationMode === "sample" && (
        <FieldRow
          label="Authored sample angles"
          value={`theta = ${draft.thetaDeg ?? "0"} deg, phi = ${draft.phiDeg ?? "0"} deg`}
        />
      )}
      {draft?.orientationMode === "global" && (
        <FieldRow label="Authored direction" value={draft.customDirection ?? "n/a"} />
      )}
    </InspectorGroup>
  );
}

function draftOrientation(
  draft: HysteresisInspectorCommonProps["draft"],
): string | null {
  if (!draft?.orientationMode) return null;
  if (draft.orientationMode === "sample") {
    return `sample(theta=${draft.thetaDeg ?? "0"} deg, phi=${draft.phiDeg ?? "0"} deg)`;
  }
  if (draft.orientationMode === "global") {
    return draft.customDirection ? `global(${draft.customDirection})` : "global";
  }
  return draft.orientationMode;
}

function formatDirection(value: readonly number[] | null | undefined): string | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((component) => Number.isFinite(component))) return null;
  return value.map((component) => component.toPrecision(6)).join(", ");
}

function formatUnknown(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
