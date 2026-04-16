"use client";

export interface FrontendDebugEvent {
  ts: number;
  scope: string;
  event: string;
  href: string | null;
  detail: Record<string, unknown> | null;
  stack: string | null;
}

declare global {
  interface Window {
    __FULLMAG_DEBUG_EVENTS__?: FrontendDebugEvent[];
  }
}

function trimEvents(events: FrontendDebugEvent[]): FrontendDebugEvent[] {
  const MAX_EVENTS = 400;
  return events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
}

export function recordFrontendDebugEvent(
  scope: string,
  event: string,
  detail: Record<string, unknown> | null = null,
  options?: { includeStack?: boolean },
): void {
  if (typeof window === "undefined") {
    return;
  }
  const entry: FrontendDebugEvent = {
    ts: Date.now(),
    scope,
    event,
    href: window.location.href,
    detail,
    stack: options?.includeStack ? new Error().stack ?? null : null,
  };
  const nextEvents = trimEvents([...(window.__FULLMAG_DEBUG_EVENTS__ ?? []), entry]);
  window.__FULLMAG_DEBUG_EVENTS__ = nextEvents;
  try {
    performance.mark(`fullmag:${scope}:${event}:${entry.ts}`);
  } catch {
    // Ignore performance API failures.
  }
  if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
    console.info(`[fullmag-debug][${scope}] ${event}`, detail ?? {});
    if (entry.stack) {
      console.info(entry.stack);
    }
  }
}
