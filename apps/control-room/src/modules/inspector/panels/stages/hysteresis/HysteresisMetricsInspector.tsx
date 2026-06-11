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
          <FieldRow label="Saturation Status" value={metrics.saturation_status ?? "n/a"} />
          {metrics.saturation_preparation_field_mT != null && (
            <FieldRow
              label="Preparation Field"
              value={metrics.saturation_preparation_field_mT.toFixed(3)}
              unit="mT"
            />
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
