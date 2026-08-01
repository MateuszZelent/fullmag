import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorGroup } from "../primitives/InspectorGroup";

/** A pinned Quick Chart is deliberately preview-only; Analysis owns controls. */
export function QuickChartInspectorPanel({ selection }: InspectorPanelProps) {
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Quick Chart">
        <QuickChartResourceView selection={selection} />
      </InspectorGroup>
    </div>
  );
}
