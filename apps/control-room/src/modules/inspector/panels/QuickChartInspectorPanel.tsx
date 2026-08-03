import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";

import { InspectorGroup } from "../primitives/InspectorGroup";

/** A pinned Quick Chart is deliberately preview-only and store-driven. */
export function QuickChartInspectorPanel() {
  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Quick Chart">
        <QuickChartResourceView />
      </InspectorGroup>
    </div>
  );
}
