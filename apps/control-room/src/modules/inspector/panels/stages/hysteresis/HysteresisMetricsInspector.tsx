"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisMetricsInspector({
  metrics,
  reversalFields,
}: Pick<HysteresisInspectorCommonProps, "metrics" | "reversalFields">) {
  return (
    <InspectorSection
      value="hysteresis-metrics"
      title="Loop Metrics"
      badge={metrics ? "ready" : "no data"}
    >
      {metrics ? (
        <>
          <FieldRow
            label="Coercivity (H_c)"
            value={metrics.H_c != null ? metrics.H_c.toFixed(2) : "n/a"}
            unit={metrics.H_c != null ? "mT" : undefined}
          />
          <FieldRow
            label="Exchange Bias (H_eb)"
            value={metrics.H_eb != null ? metrics.H_eb.toFixed(2) : "n/a"}
            unit={metrics.H_eb != null ? "mT" : undefined}
          />
          <FieldRow
            label="Positive Coercivity (H_c+)"
            value={metrics.H_c_plus != null ? metrics.H_c_plus.toFixed(2) : "n/a"}
            unit={metrics.H_c_plus != null ? "mT" : undefined}
          />
          <FieldRow
            label="Negative Coercivity (H_c-)"
            value={metrics.H_c_minus != null ? metrics.H_c_minus.toFixed(2) : "n/a"}
            unit={metrics.H_c_minus != null ? "mT" : undefined}
          />
          <FieldRow
            label="Positive Remanence (M_r+)"
            value={metrics.M_r_plus != null ? metrics.M_r_plus.toFixed(4) : "n/a"}
          />
          <FieldRow
            label="Negative Remanence (M_r-)"
            value={metrics.M_r_minus != null ? metrics.M_r_minus.toFixed(4) : "n/a"}
          />
          <FieldRow
            label="Loop Area"
            value={metrics.loop_area != null ? metrics.loop_area.toExponential(4) : "n/a"}
          />
          {metrics.loop_closure_summary && (
            <FieldRow
              label="Loop Closure"
              value={`${metrics.loop_closure_summary.status}: dH=${metrics.loop_closure_summary.field_gap_mT.toFixed(3)} mT, dm=${metrics.loop_closure_summary.m_parallel_gap.toExponential(3)}`}
            />
          )}
          <FieldRow
            label="Max Differential Susceptibility"
            value={
              metrics.max_differential_susceptibility != null
                ? metrics.max_differential_susceptibility.toExponential(4)
                : "n/a"
            }
            unit={metrics.max_differential_susceptibility != null ? "1/mT" : undefined}
          />
          <FieldRow
            label="Switching Candidates"
            value={
              metrics.switching_field_candidates &&
              metrics.switching_field_candidates.length > 0
                ? metrics.switching_field_candidates
                    .map(
                      (candidate) =>
                        `${candidate.field_value_mT.toFixed(3)} mT (${candidate.susceptibility_per_mT.toExponential(3)} 1/mT)`,
                    )
                    .join(", ")
                : "none detected"
            }
          />
          <FieldRow label="Saturation Status" value={metrics.saturation_status ?? "n/a"} />
          {metrics.saturation_preparation_field_mT != null && (
            <FieldRow
              label="Preparation Field"
              value={metrics.saturation_preparation_field_mT.toFixed(3)}
              unit="mT"
            />
          )}
          {metrics.convergence_quality_summary && (
            <FieldRow
              label="Convergence Summary"
              value={`${metrics.convergence_quality_summary.status}: ${metrics.convergence_quality_summary.converged_points}/${metrics.convergence_quality_summary.total_points} converged, ${metrics.convergence_quality_summary.warning_points} warning, ${metrics.convergence_quality_summary.non_converged_points} non-converged`}
            />
          )}
          {metrics.metric_statuses && Object.keys(metrics.metric_statuses).length > 0 && (
            <FieldRow
              label="Metric Statuses"
              value={formatMetricStatuses(metrics.metric_statuses)}
            />
          )}
          {metrics.warnings && metrics.warnings.length > 0 && (
            <FieldRow label="Metric Warnings" value={metrics.warnings.join("; ")} />
          )}
          <FieldRow
            label="Reversal Fields"
            value={
              reversalFields.length > 0
                ? reversalFields
                    .map(
                      (point) =>
                        `${point.field_value_mT.toFixed(3)} mT (point ${point.point_id})`,
                    )
                    .join(", ")
                : "none detected"
            }
          />
        </>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          No metrics available. Run the simulation to calculate loop parameters.
        </div>
      )}
    </InspectorSection>
  );
}

function formatMetricStatuses(
  statuses: NonNullable<
    NonNullable<HysteresisInspectorCommonProps["metrics"]>["metric_statuses"]
  >,
): string {
  return Object.entries(statuses)
    .map(([metricId, status]) => `${metricId}: ${status.status}`)
    .join("; ");
}
