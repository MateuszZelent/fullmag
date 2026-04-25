/**
 * P1 — Interaction Trace Bus
 *
 * Centralised dev-only trace for UI interaction events.
 * Gated by FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace.
 * No private data or large payloads are logged.
 */

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { incrementCounter } from "@/features/diagnostics/events/counters";

// ── Event vocabulary ──────────────────────────────────────────

export type UiInteractionEvent =
  | "tree.select"
  | "tree.context.focus"
  | "ribbon.command"
  | "inspector.draft.change"
  | "inspector.apply"
  | "viewport.mode.change"
  | "viewport.tool.change"
  | "viewport.object.click"
  | "viewport.camera.fit"
  | "viewport.camera.reset"
  | "viewport.gizmo.drag.start"
  | "viewport.gizmo.drag.commit"
  | "scene.transaction"
  | "dirtygraph.invalidate"
  | "run.gate.update"
  | "selection.clear"
  | "selection.focus";

// ── Trace context snapshot ────────────────────────────────────

export interface InteractionTraceContext {
  eventId: string;
  timestamp: number;
  source: "tree" | "ribbon" | "inspector" | "viewport" | "dirtygraph" | "command";
  selectedNodeId: string | null;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  hoveredObjectId?: string | null;
  viewportMode: "camera" | "manipulate";
  transformTool: "select" | "move" | "rotate" | "scale" | null;
  transformScope: "object" | "magnetization_texture" | null;
  activeRibbonTab?: string | null;
  meshRevision?: string | null;
  geometryRevision?: string | null;
  fieldRevision?: string | null;
  runBlockers?: string[];
}

// ── Ring buffer for trace entries ─────────────────────────────

const MAX_TRACE_ENTRIES = 200;

interface TraceEntry {
  event: UiInteractionEvent;
  payload: unknown;
  context: Partial<InteractionTraceContext>;
}

const traceBuffer: TraceEntry[] = [];
const traceListeners = new Set<(entry: TraceEntry) => void>();

// ── Counter helper ─────────────────────────────────────────────

let nextEventId = 1;

export function generateEventId(): string {
  return `ie-${nextEventId++}-${Date.now()}`;
}

// ── Main trace function ────────────────────────────────────────

export function traceInteraction(
  event: UiInteractionEvent,
  payload: unknown = null,
  context: Partial<InteractionTraceContext> = {},
): void {
  const flags = FRONTEND_DIAGNOSTIC_FLAGS as Record<string, unknown>;
  const interactions = flags["interactions"] as Record<string, unknown> | undefined;
  if (!interactions?.["trace"]) return;

  const entry: TraceEntry = {
    event,
    payload,
    context: {
      ...context,
      eventId: context.eventId ?? generateEventId(),
      timestamp: context.timestamp ?? Date.now(),
    },
  };

  traceBuffer.push(entry);
  if (traceBuffer.length > MAX_TRACE_ENTRIES) {
    traceBuffer.shift();
  }

  // Notify listeners
  for (const listener of traceListeners) {
    listener(entry);
  }

  // Also increment diagnostic counter
  incrementCounter(`interaction:${event}`);

  if (process.env.NODE_ENV === "development") {
    console.debug(`[interaction] ${event}`, payload);
  }
}

// ── Subscription for dev tools ─────────────────────────────────

export function subscribeToTrace(listener: (entry: TraceEntry) => void): () => void {
  traceListeners.add(listener);
  return () => {
    traceListeners.delete(listener);
  };
}

export function getTraceSnapshot(): readonly TraceEntry[] {
  return traceBuffer;
}

export function clearTrace(): void {
  traceBuffer.length = 0;
}
