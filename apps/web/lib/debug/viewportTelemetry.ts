import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

export interface ViewportTelemetryEntry {
  id: string;
  label: string;
  renderer: "webgl" | "plotly" | "other";
  drawCalls: number;
  triangles: number;
  lines: number;
  points: number;
  geometries: number;
  textures: number;
  frameloop: "always" | "demand" | "never" | "n/a";
  hidden: boolean;
  width: number;
  height: number;
  dpr: number;
  lastFrameAt: number;
  lastFrameAtUnixMs: number;
  mountedAt: number;
  lifecycle: ViewportLifecycleTelemetryCounts;
}

export interface ViewportLifecycleTelemetryCounts {
  canvasMounts: number;
  canvasUnmounts: number;
  contextLost: number;
  contextRestored: number;
  cameraFits: number;
  cameraRestores: number;
  cameraPersists: number;
  topologyRebuilds: number;
  fieldBufferUpdates: number;
}

export type ViewportLifecycleTelemetryEvent =
  | "canvas_mount"
  | "canvas_unmount"
  | "context_lost"
  | "context_restored"
  | "camera_fit"
  | "camera_restore"
  | "camera_persist"
  | "topology_rebuild"
  | "field_buffer_update";

const EMPTY_LIFECYCLE_COUNTS: ViewportLifecycleTelemetryCounts = {
  canvasMounts: 0,
  canvasUnmounts: 0,
  contextLost: 0,
  contextRestored: 0,
  cameraFits: 0,
  cameraRestores: 0,
  cameraPersists: 0,
  topologyRebuilds: 0,
  fieldBufferUpdates: 0,
};

const listeners = new Set<() => void>();
const entries = new Map<string, ViewportTelemetryEntry>();
let nextViewportTelemetryId = 1;
let telemetrySnapshot: ViewportTelemetryEntry[] = [];
let telemetryEmitScheduled = false;

function emitViewportTelemetryChange(): void {
  if (telemetryEmitScheduled) return;
  telemetryEmitScheduled = true;
  const schedule =
    typeof queueMicrotask === "function"
      ? queueMicrotask
      : (callback: () => void) => {
          setTimeout(callback, 0);
        };
  schedule(() => {
    telemetryEmitScheduled = false;
    for (const listener of listeners) {
      listener();
    }
  });
}

function refreshTelemetrySnapshot(): void {
  telemetrySnapshot = Array.from(entries.values()).sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export function getViewportTelemetrySnapshot(): ViewportTelemetryEntry[] {
  return telemetrySnapshot;
}

export function createViewportTelemetryId(prefix: string): string {
  const sanitized = prefix.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const id = `${sanitized || "viewport"}-${nextViewportTelemetryId}`;
  nextViewportTelemetryId += 1;
  return id;
}

export function registerViewportTelemetry(entry: ViewportTelemetryEntry): void {
  entries.set(entry.id, entry);
  refreshTelemetrySnapshot();
  emitViewportTelemetryChange();
}

export function updateViewportTelemetry(
  id: string,
  patch: Partial<ViewportTelemetryEntry>,
): void {
  const current = entries.get(id);
  if (!current) {
    return;
  }
  entries.set(id, { ...current, ...patch });
  refreshTelemetrySnapshot();
  emitViewportTelemetryChange();
}

export function recordViewportLifecycleEvent(
  id: string,
  event: ViewportLifecycleTelemetryEvent,
): void {
  const current = entries.get(id);
  if (!current) {
    return;
  }
  const lifecycle = { ...current.lifecycle };
  switch (event) {
    case "canvas_mount":
      lifecycle.canvasMounts += 1;
      break;
    case "canvas_unmount":
      lifecycle.canvasUnmounts += 1;
      break;
    case "context_lost":
      lifecycle.contextLost += 1;
      break;
    case "context_restored":
      lifecycle.contextRestored += 1;
      break;
    case "camera_fit":
      lifecycle.cameraFits += 1;
      break;
    case "camera_restore":
      lifecycle.cameraRestores += 1;
      break;
    case "camera_persist":
      lifecycle.cameraPersists += 1;
      break;
    case "topology_rebuild":
      lifecycle.topologyRebuilds += 1;
      break;
    case "field_buffer_update":
      lifecycle.fieldBufferUpdates += 1;
      break;
  }
  entries.set(id, { ...current, lifecycle });
  refreshTelemetrySnapshot();
  emitViewportTelemetryChange();
}

export function recordViewportLifecycleEventForLabel(
  label: string,
  event: ViewportLifecycleTelemetryEvent,
): void {
  const ids = Array.from(entries.values())
    .filter((entry) => entry.label === label)
    .map((entry) => entry.id);
  for (const id of ids) {
    recordViewportLifecycleEvent(id, event);
  }
}

export function unregisterViewportTelemetry(id: string): void {
  if (!entries.delete(id)) {
    return;
  }
  refreshTelemetrySnapshot();
  emitViewportTelemetryChange();
}

function subscribeViewportTelemetry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useViewportTelemetrySnapshot(): ViewportTelemetryEntry[] {
  return useSyncExternalStore(
    subscribeViewportTelemetry,
    getViewportTelemetrySnapshot,
    getViewportTelemetrySnapshot,
  );
}

export function useViewportTelemetryEntry(args: {
  label: string;
  renderer: ViewportTelemetryEntry["renderer"];
  frameloop?: ViewportTelemetryEntry["frameloop"];
  hidden?: boolean;
}) {
  const { frameloop = "n/a", hidden = false, label, renderer } = args;
  const [id] = useState(() => createViewportTelemetryId(label));

  useEffect(() => {
    registerViewportTelemetry({
      id,
      label,
      renderer,
      drawCalls: 0,
      triangles: 0,
      lines: 0,
      points: 0,
      geometries: 0,
      textures: 0,
      frameloop,
      hidden,
      width: 0,
      height: 0,
      dpr: 1,
      lastFrameAt: 0,
      lastFrameAtUnixMs: 0,
      mountedAt: 0,
      lifecycle: { ...EMPTY_LIFECYCLE_COUNTS },
    });
    updateViewportTelemetry(id, {
      mountedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
    });
    return () => {
      unregisterViewportTelemetry(id);
    };
  }, [frameloop, hidden, id, label, renderer]);

  useEffect(() => {
    updateViewportTelemetry(id, { frameloop, hidden, label, renderer });
  }, [frameloop, hidden, id, label, renderer]);

  const update = useCallback((patch: Partial<ViewportTelemetryEntry>) => {
    updateViewportTelemetry(id, patch);
  }, [id]);
  const recordLifecycleEvent = useCallback((event: ViewportLifecycleTelemetryEvent) => {
    recordViewportLifecycleEvent(id, event);
  }, [id]);

  return useMemo(
    () => ({
      id,
      update,
      recordLifecycleEvent,
    }),
    [id, recordLifecycleEvent, update],
  );
}
