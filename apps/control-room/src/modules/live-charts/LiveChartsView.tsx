"use client";

import { Activity } from "lucide-react";
import { LiveChartControls } from "./components/LiveChartControls";
import { LiveChartSurface } from "./components/LiveChartSurface";
import type { LiveChartsViewProps } from "./liveChartsViewTypes";

export function LiveChartsView(props: LiveChartsViewProps) {
  return <div className="fm-live-charts">
    <header className="fm-live-charts__header">
      <div className="fm-live-charts__identity">
        <span className="fm-live-charts__mark"><Activity size={22} aria-hidden="true" /></span>
        <div><span className="fm-live-charts__eyebrow">Live Charts</span><h2>Simulation traces</h2><p>Signals and recorded values from the active run.</p></div>
      </div>
    </header>
    <LiveChartControls {...props} />
    <div className="fm-live-charts__surface"><LiveChartSurface {...props} /></div>
  </div>;
}
