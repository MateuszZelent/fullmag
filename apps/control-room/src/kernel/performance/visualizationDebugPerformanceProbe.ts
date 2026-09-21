export interface VisualizationDebugPerformanceCounters {
  cacheEvictions?: number;
  cacheHits?: number;
  cacheMisses?: number;
  canvasContextsCreated?: number;
  canvasContextsDisposed?: number;
  canvasEventConnections?: number;
  canvasEventDisconnections?: number;
  canvasRootConfigureCompleted?: number;
  canvasRootConfigureStarted?: number;
  fieldDecodes?: number;
  fieldSwaps?: number;
  geometriesCreated?: number;
  geometriesDisposed?: number;
  gpuUploadBytes?: number;
  gpuUploads?: number;
  materialsCreated?: number;
  materialsDisposed?: number;
  publishes: number;
  resourceCounts?: VisualizationDebugResourceCounts;
  retentionRejections?: Record<string, number>;
  scans: number;
  topologyBuilds?: number;
  topologyUploads?: number;
  typedArrayCopiedBytes?: number;
  uploadTicketsAborted?: number;
  viewportFrameReasonsDropped?: number;
  viewportFrameReasonsOverflowed?: boolean;
  viewportFrameReasons?: Record<string, number>;
  viewportFrames: number;
  workerJobs?: number;
}

export const VISUALIZATION_DEBUG_VIEWPORT_FRAME_REASON_LIMIT = 64;

const viewportFrameReasonCounts = new WeakMap<
  VisualizationDebugPerformanceCounters,
  number
>();

export type VisualizationDebugPerformanceMetric = Exclude<
  {
    [TKey in keyof VisualizationDebugPerformanceCounters]:
      VisualizationDebugPerformanceCounters[TKey] extends number | undefined
        ? TKey
        : never;
  }[keyof VisualizationDebugPerformanceCounters],
  undefined
>;

export type VisualizationDebugCanvasLifecycleEvent =
  | "context-created"
  | "context-disposed"
  | "events-connected"
  | "events-disconnected"
  | "root-configure-completed"
  | "root-configure-started";

type VisualizationDebugCanvasLifecycleCounterKey =
  | "canvasContextsCreated"
  | "canvasContextsDisposed"
  | "canvasEventConnections"
  | "canvasEventDisconnections"
  | "canvasRootConfigureCompleted"
  | "canvasRootConfigureStarted";

export interface VisualizationDebugResourceCounts {
  geometries: number;
  materials: number;
  renderTargets: number;
  textures: number;
  workers: number;
}

export interface Viewport3DLiveRefreshRevisions {
  displayed: string | null;
  prepared: string | null;
  received: string | null;
  requested: string | null;
}

export interface Viewport3DLiveRefreshProbe {
  revisions: Viewport3DLiveRefreshRevisions;
}

declare global {
  interface Window {
    __FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__?: VisualizationDebugPerformanceCounters;
    __FULLMAG_VIEWPORT_3D_LIVE_REFRESH__?: Viewport3DLiveRefreshProbe;
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

export function recordVisualizationDebugPerformanceMetric(
  metric: VisualizationDebugPerformanceMetric,
  delta = 1,
): void {
  const counters = readCounters();
  if (!counters || !Number.isFinite(delta) || delta <= 0) return;
  counters[metric] = (counters[metric] ?? 0) + delta;
}

export function recordVisualizationDebugRetentionRejection(
  reason: string,
): void {
  const counters = readCounters();
  if (!counters || typeof reason !== "string" || reason.length === 0) return;
  counters.retentionRejections ??= {};
  counters.retentionRejections[reason] =
    (counters.retentionRejections[reason] ?? 0) + 1;
}

export function publishViewport3DLiveRefreshRevisions(
  revisions: Viewport3DLiveRefreshRevisions,
): void {
  if (typeof window === "undefined") return;
  window.__FULLMAG_VIEWPORT_3D_LIVE_REFRESH__ = { revisions: { ...revisions } };
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
  const existingCount = reasons[reason];
  if (existingCount !== undefined) {
    reasons[reason] = existingCount + 1;
    return;
  }

  const knownReasonCount =
    viewportFrameReasonCounts.get(counters) ?? Object.keys(reasons).length;
  if (knownReasonCount >= VISUALIZATION_DEBUG_VIEWPORT_FRAME_REASON_LIMIT) {
    counters.viewportFrameReasonsDropped =
      (counters.viewportFrameReasonsDropped ?? 0) + 1;
    counters.viewportFrameReasonsOverflowed = true;
    return;
  }

  reasons[reason] = 1;
  viewportFrameReasonCounts.set(counters, knownReasonCount + 1);
}

export function recordVisualizationDebugCanvasLifecycle(
  event: VisualizationDebugCanvasLifecycleEvent,
): void {
  const counters = readCounters();
  if (!counters) return;
  const keys: Record<
    VisualizationDebugCanvasLifecycleEvent,
    VisualizationDebugCanvasLifecycleCounterKey
  > = {
    "context-created": "canvasContextsCreated",
    "context-disposed": "canvasContextsDisposed",
    "events-connected": "canvasEventConnections",
    "events-disconnected": "canvasEventDisconnections",
    "root-configure-completed": "canvasRootConfigureCompleted",
    "root-configure-started": "canvasRootConfigureStarted",
  };
  const key = keys[event];
  counters[key] = (counters[key] ?? 0) + 1;
}

function readCounters(): VisualizationDebugPerformanceCounters | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__;
}
