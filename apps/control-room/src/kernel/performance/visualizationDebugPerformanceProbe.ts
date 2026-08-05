export interface VisualizationDebugPerformanceCounters {
  publishes: number;
  resourceCounts?: VisualizationDebugResourceCounts;
  scans: number;
  viewportFrameReasons?: Record<string, number>;
  viewportFrames: number;
}

export interface VisualizationDebugResourceCounts {
  geometries: number;
  materials: number;
  renderTargets: number;
  textures: number;
  workers: number;
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

export function recordVisualizationDebugResourceCounts(
  counts: VisualizationDebugResourceCounts,
): void {
  const counters = readCounters();
  if (!counters) return;
  counters.resourceCounts = { ...counts };
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
