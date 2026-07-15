export interface VisualizationDebugPerformanceCounters {
  publishes: number;
  scans: number;
  viewportFrames: number;
}

declare global {
  interface Window {
    __FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__?: VisualizationDebugPerformanceCounters;
  }
}

export function recordVisualizationDebugPublish(): void {
  const counters = readCounters();
  if (counters) counters.publishes += 1;
}

export function recordVisualizationDebugScan(): void {
  const counters = readCounters();
  if (counters) counters.scans += 1;
}

export function recordVisualizationDebugViewportFrame(): void {
  const counters = readCounters();
  if (counters) counters.viewportFrames += 1;
}

function readCounters(): VisualizationDebugPerformanceCounters | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__;
}
