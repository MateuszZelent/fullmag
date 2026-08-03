import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorGroup } from "../primitives/InspectorGroup";

/** A pinned Quick Chart is deliberately preview-only and store-driven. */
export function QuickChartInspectorPanel(_props: InspectorPanelProps) {
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Quick Chart">
        <QuickChartResourceView />
      </InspectorGroup>
    </div>
  );
}
