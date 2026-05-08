"use client";

export type FrontendAuditCounter =
  | "viewportBridgeMounted"
  | "viewportBridgeActive"
  | "webglCanvasMounted"
  | "webglCanvasHidden"
  | "field2DRequests"
  | "field2DInflight"
  | "fieldVectorRequests"
  | "fieldVectorInflight"
  | "dataPlaneFetches"
  | "liveStatusPolls"
  | "realtimeEvents"
  | "statusNormalizations"
  | "scalarRows"
  | "scalarAccumulatorBytesApprox"
  | "viewportRenderCounts"
  | "typedArrayAllocations"
  | "webglFrames"
  | "viewportInvalidates";

export type FrontendAuditCounters = Record<FrontendAuditCounter, number>;

export interface FrontendAuditSnapshot {
  counters: FrontendAuditCounters;
  webgl: Array<FrontendAuditWebGLInfo>;
  marks: Array<{ name: string; at: number }>;
  measures: Array<{ name: string; durationMs: number; at: number }>;
}

export interface FrontendAuditWebGLInfo {
  label: string;
  version: string | null;
  vendor: string | null;
  renderer: string | null;
  unmaskedVendor: string | null;
  unmaskedRenderer: string | null;
  maxTextureSize: number | null;
  maxRenderbufferSize: number | null;
  at: number;
}

const COUNTER_NAMES: FrontendAuditCounter[] = [
  "viewportBridgeMounted",
  "viewportBridgeActive",
  "webglCanvasMounted",
  "webglCanvasHidden",
  "field2DRequests",
  "field2DInflight",
  "fieldVectorRequests",
  "fieldVectorInflight",
  "dataPlaneFetches",
  "liveStatusPolls",
  "realtimeEvents",
  "statusNormalizations",
  "scalarRows",
  "scalarAccumulatorBytesApprox",
  "viewportRenderCounts",
  "typedArrayAllocations",
  "webglFrames",
  "viewportInvalidates",
];

const MAX_TIMING_SAMPLES = 200;

function emptyCounters(): FrontendAuditCounters {
  return Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0])) as FrontendAuditCounters;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function ensureFrontendAudit(): FrontendAuditSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  const target = window as Window & { __FULLMAG_AUDIT__?: FrontendAuditSnapshot };
  if (!target.__FULLMAG_AUDIT__) {
    target.__FULLMAG_AUDIT__ = {
      counters: emptyCounters(),
      webgl: [],
      marks: [],
      measures: [],
    };
  }
  return target.__FULLMAG_AUDIT__;
}

export function incrementFrontendAuditCounter(
  name: FrontendAuditCounter,
  delta = 1,
): void {
  const audit = ensureFrontendAudit();
  if (!audit) return;
  audit.counters[name] = (audit.counters[name] ?? 0) + delta;
}

export function setFrontendAuditCounter(name: FrontendAuditCounter, value: number): void {
  const audit = ensureFrontendAudit();
  if (!audit) return;
  audit.counters[name] = Number.isFinite(value) ? value : 0;
}

export function markFrontendAudit(name: string): void {
  const audit = ensureFrontendAudit();
  if (!audit) return;
  audit.marks.push({ name, at: nowMs() });
  if (audit.marks.length > MAX_TIMING_SAMPLES) {
    audit.marks.splice(0, audit.marks.length - MAX_TIMING_SAMPLES);
  }
}

export function measureFrontendAudit<T>(name: string, fn: () => T): T {
  const start = nowMs();
  try {
    return fn();
  } finally {
    const audit = ensureFrontendAudit();
    if (audit) {
      audit.measures.push({ name, durationMs: nowMs() - start, at: nowMs() });
      if (audit.measures.length > MAX_TIMING_SAMPLES) {
        audit.measures.splice(0, audit.measures.length - MAX_TIMING_SAMPLES);
      }
    }
  }
}

export function recordFrontendAuditWebGLContext(
  label: string,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): void {
  const audit = ensureFrontendAudit();
  if (!audit) return;
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const info: FrontendAuditWebGLInfo = {
    label,
    version: gl.getParameter(gl.VERSION) as string | null,
    vendor: gl.getParameter(gl.VENDOR) as string | null,
    renderer: gl.getParameter(gl.RENDERER) as string | null,
    unmaskedVendor: debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string | null)
      : null,
    unmaskedRenderer: debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string | null)
      : null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null,
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number | null,
    at: nowMs(),
  };
  const existingIndex = audit.webgl.findIndex((entry) => entry.label === label);
  if (existingIndex >= 0) {
    audit.webgl[existingIndex] = info;
    return;
  }
  audit.webgl.push(info);
}

declare global {
  interface Window {
    __FULLMAG_AUDIT__?: FrontendAuditSnapshot;
  }
}
