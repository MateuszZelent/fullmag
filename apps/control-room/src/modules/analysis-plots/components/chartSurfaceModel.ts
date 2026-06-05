import type { ECharts } from "echarts";

import type { ChartSeries } from "../chartTableModel";
import { buildChartOption } from "./chartOption";
import type { ChartFrameScheduler } from "./chartFrameScheduler";
import { recordChartSetOption } from "./chartDiagnostics";

export type ChartRendererStatus = "loading" | "ready" | "error";

export function chartStatusOverlay({
  dataStatus,
  hasSamples,
  rendererStatus,
}: {
  dataStatus?: string;
  hasSamples: boolean;
  rendererStatus: ChartRendererStatus;
}): { label: string; role: "alert" | "status" } | null {
  if (!hasSamples) {
    if (dataStatus === "loading" || dataStatus === "stale") {
      return { label: "Loading table samples", role: "status" };
    }
    if (dataStatus === "error") {
      return { label: "Table samples unavailable", role: "alert" };
    }
    return { label: "No table samples", role: "status" };
  }
  if (rendererStatus === "loading") {
    return { label: "Loading chart renderer", role: "status" };
  }
  if (rendererStatus === "error") {
    return { label: "Chart renderer unavailable", role: "alert" };
  }
  return null;
}

export function scheduleChartOptionUpdate({
  chart,
  element,
  scheduler,
  series,
  xAxisLabel,
}: {
  chart: ECharts;
  element: HTMLElement;
  scheduler: ChartFrameScheduler | null;
  series: readonly ChartSeries[];
  xAxisLabel?: string;
}): void {
  const update = () => {
    chart.setOption(
      buildChartOption(series, { xAxisLabel }, readChartPalette(element)),
      true,
    );
    recordChartSetOption();
  };
  if (!scheduler) {
    update();
    return;
  }
  scheduler.schedule(update);
}

export function scheduleRangeCommit(
  timerRef: { current: number | null },
  commit: () => void,
): void {
  cancelRangeCommit(timerRef);
  timerRef.current = window.setTimeout(() => {
    timerRef.current = null;
    commit();
  }, 200);
}

export function cancelRangeCommit(timerRef: { current: number | null }): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

function readChartPalette(element: HTMLElement): string[] {
  const style = getComputedStyle(element);
  return [
    "--fm-chart-blue",
    "--fm-chart-green",
    "--fm-chart-yellow",
    "--fm-chart-red",
    "--fm-chart-mauve",
  ].map((token) => style.getPropertyValue(token).trim());
}
