import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

export function ChartInspectorPanel({ selection }: InspectorPanelProps) {
  const tableId =
    selection.ref?.type === "analysis-chart" ? selection.ref.tableId : "default";
  const chartId =
    selection.ref?.type === "analysis-chart" ? selection.ref.chartId : "default";

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Table Autosave">
        <FieldRow label="Chart" value={chartId} />
        <FieldRow label="Table" value={tableId} />
        <FieldRow label="Cadence" value="study.table_autosave(t_sampl)" />
      </InspectorSection>
      <InspectorSection title="Series">
        <FieldRow label="Default columns" value="step, t, mx, my, mz, e_total, max_torque" />
        <FieldRow label="Axis policy" value="same-unit grouping; max two Y axes" />
      </InspectorSection>
      <InspectorSection title="Range">
        <FieldRow label="Mode" value="follow table cursor" />
        <FieldRow label="Visible cap" value="5000 rows" />
        <FieldRow label="Decimation" value="server target_points + bounded client window" />
      </InspectorSection>
    </div>
  );
}
