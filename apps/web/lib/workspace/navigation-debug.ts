"use client";

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";

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

const MAX_DETAIL_KEYS = 32;
const MAX_DETAIL_TEXT_LENGTH = 240;

function trimEvents(events: FrontendDebugEvent[]): FrontendDebugEvent[] {
  const MAX_EVENTS = 400;
  return events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
}

function summarizeDebugValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_TEXT_LENGTH
      ? `${value.slice(0, MAX_DETAIL_TEXT_LENGTH - 3)}...`
      : value;
  }
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      length: "length" in value && typeof value.length === "number" ? value.length : null,
      byteLength: value.byteLength,
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      type: "ArrayBuffer",
      byteLength: value.byteLength,
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "Array",
      length: value.length,
    };
  }
  if (typeof value === "object") {
    return {
      type: value.constructor?.name ?? "Object",
    };
  }
  return String(value);
}

function sanitizeDebugDetail(detail: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!detail) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, MAX_DETAIL_KEYS)
      .map(([key, value]) => [
        key.length > MAX_DETAIL_TEXT_LENGTH
          ? `${key.slice(0, MAX_DETAIL_TEXT_LENGTH - 3)}...`
          : key,
        summarizeDebugValue(value),
      ]),
  );
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
    detail: sanitizeDebugDetail(detail),
    stack: options?.includeStack ? new Error().stack ?? null : null,
  };
  const nextEvents = trimEvents([...(window.__FULLMAG_DEBUG_EVENTS__ ?? []), entry]);
  window.__FULLMAG_DEBUG_EVENTS__ = nextEvents;
  const markName = `fullmag:${scope}:${event}:${entry.ts}`;
  try {
    performance.mark(markName);
    performance.clearMarks(markName);
  } catch {
    // Ignore performance API failures.
  }
  if (
    typeof process !== "undefined" &&
    process.env.NODE_ENV !== "production" &&
    FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging
  ) {
    writeFrontendDiagnosticConsole("info", `[fullmag-debug][${scope}] ${event}`, entry.detail ?? {});
    if (entry.stack) {
      writeFrontendDiagnosticConsole("info", entry.stack);
    }
  }
}
