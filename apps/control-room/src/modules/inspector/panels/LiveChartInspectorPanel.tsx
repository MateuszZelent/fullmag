import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

export function LiveChartInspectorPanel({ selection }: InspectorPanelProps) {
  const ref =
    selection.ref?.type === "live-chart" ||
    selection.ref?.type === "live-chart-point"
      ? selection.ref
      : null;
  const point = ref?.type === "live-chart-point" ? ref : null;

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Live Chart">
        <FieldRow label="Descriptor" value={ref?.descriptorId ?? "not available"} />
      </InspectorGroup>
      {point ? (
        <InspectorGroup title="Selected Point">
          <FieldRow label="Series" value={point.seriesId} />
          <FieldRow label="Point" value={String(point.pointIndex)} />
          <FieldRow label="Revision" value={String(point.revision)} />
        </InspectorGroup>
      ) : null}
    </div>
  );
}
