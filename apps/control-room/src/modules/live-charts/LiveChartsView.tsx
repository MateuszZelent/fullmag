"use client";

import { LiveChartControls } from "./components/LiveChartControls";
import { LiveChartSurface } from "./components/LiveChartSurface";
import type { LiveChartsViewProps } from "./liveChartsViewTypes";

export function LiveChartsView(props: LiveChartsViewProps) {
  return <div className="fm-live-charts">
    <LiveChartControls descriptorId={props.descriptorId} following={props.isFollowing} onDescriptorChange={props.onDescriptorChange} onExport={props.onExport} onFit={props.onFit} onToggleFollow={props.onToggleFollow} />
    <div className="fm-live-charts__surface"><LiveChartSurface {...props} /></div>
  </div>;
}
