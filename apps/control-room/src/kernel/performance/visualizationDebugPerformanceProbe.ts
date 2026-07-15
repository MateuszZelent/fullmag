export interface VisualizationDebugPerformanceCounters {
  publishes: number;
  scans: number;
  viewportFrameReasons?: Record<string, number>;
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

export function recordVisualizationDebugViewportFrame(reason: string): void {
  const counters = readCounters();
  if (!counters) return;
  counters.viewportFrames += 1;
  const reasons = (counters.viewportFrameReasons ??= {});
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function readCounters(): VisualizationDebugPerformanceCounters | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__;
}
