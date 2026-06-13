"use client";

import type { HysteresisAngularFamilyResource } from "@/kernel/api/apiTypes";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisAngularFamilyInspector({
  angularFamily,
}: Pick<HysteresisInspectorCommonProps, "angularFamily">) {
  const series = angularFamily?.series ?? [];
  const computedCount = series.filter((entry) => entry.points.length > 0).length;
  const pendingCount = series.filter((entry) => entry.points.length === 0).length;

  return (
    <InspectorSection
      value="hysteresis-angular-family"
      title="Angular Family"
      badge={angularFamily ? `${computedCount}/${series.length} computed` : "not available"}
    >
      {angularFamily ? (
        <>
          <FieldRow label="Family" value={angularFamily.family_id} />
          <FieldRow label="Label" value={angularFamily.label ?? "n/a"} />
          <FieldRow
            label="Active variant"
            value={angularFamily.active_variant_id ?? "n/a"}
          />
          <FieldRow label="Revision" value={String(angularFamily.revision)} />
          <FieldRow label="Variants" value={String(series.length)} />
          <FieldRow label="Computed" value={String(computedCount)} />
          <FieldRow label="Pending" value={String(pendingCount)} />
          {series.length > 0 ? (
            <div className="fm-hysteresis-inspector-list">
              {series.map((variant) => (
                <AngularFamilyVariantRow
                  family={angularFamily}
                  key={variant.variant_id}
                  variant={variant}
                />
              ))}
            </div>
          ) : (
            <div className="fm-hysteresis-inspector-empty">
              Angular family contains no variants.
            </div>
          )}
        </>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          No angular-family runtime artifact is available for this hysteresis
          stage yet.
        </div>
      )}
    </InspectorSection>
  );
}

function AngularFamilyVariantRow({
  family,
  variant,
}: {
  family: HysteresisAngularFamilyResource;
  variant: HysteresisAngularFamilyResource["series"][number];
}) {
  const metricsStatus = variant.metrics
    ? `H_c=${formatMetric(variant.metrics.H_c)}, loop_area=${formatMetric(variant.metrics.loop_area)}`
    : "n/a";
  const isActive = family.active_variant_id === variant.variant_id;

  return (
    <div className="fm-hysteresis-inspector-list__item">
      <FieldRow label="Variant" value={variant.variant_id} />
      <FieldRow label="Label" value={variant.label ?? "n/a"} />
      <FieldRow
        label="Status"
        value={isActive ? `${variant.data_status} (active)` : variant.data_status}
      />
      <FieldRow label="Points" value={String(variant.point_count)} />
      <FieldRow label="Loaded points" value={String(variant.points.length)} />
      <FieldRow label="Orientation" value={jsonSummary(variant.orientation)} />
      <FieldRow
        label="Measurement axis"
        value={jsonSummary(variant.measurement_axis)}
      />
      <FieldRow label="Metrics" value={metricsStatus} />
      <FieldRow label="Points resource" value={variant.points_resource_ref} />
    </div>
  );
}

function formatMetric(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toExponential(4)
    : "n/a";
}

function jsonSummary(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
