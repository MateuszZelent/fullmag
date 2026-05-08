"use client";

export type FrontendAuditCounter =
  | "viewportBridgeMounted"
  | "viewportBridgeActive"
  | "viewportResourceOwnerMounted"
  | "viewportResourceOwnerUnmounted"
  | "webglCanvasMounted"
  | "webglCanvasHidden"
  | "field2DRequests"
  | "field2DInflight"
  | "fieldVectorRequests"
  | "fieldVectorInflight"
  | "fieldVectorGlyphRequests"
  | "fieldVectorShaderRequests"
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
  resourceFetches: Record<string, number>;
  webgl: Array<FrontendAuditWebGLInfo>;
  marks: Array<{ name: string; at: number }>;
  measures: Array<{ name: string; durationMs: number; at: number }>;
  snapshotDelta: (seconds?: number) => Promise<FrontendAuditDelta>;
}

export interface FrontendAuditDelta {
  seconds: number;
  elapsedMs: number;
  counters: FrontendAuditCounters;
  resourceFetches: Record<string, number>;
  memory: FrontendAuditMemoryDelta | null;
  webgl: Array<FrontendAuditWebGLInfo>;
  startedAt: number;
  endedAt: number;
}

export interface FrontendAuditMemorySnapshot {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface FrontendAuditMemoryDelta {
  before: FrontendAuditMemorySnapshot;
  after: FrontendAuditMemorySnapshot;
  deltaUsedJSHeapSize: number;
  deltaTotalJSHeapSize: number;
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
  "viewportResourceOwnerMounted",
  "viewportResourceOwnerUnmounted",
  "webglCanvasMounted",
  "webglCanvasHidden",
  "field2DRequests",
  "field2DInflight",
  "fieldVectorRequests",
  "fieldVectorInflight",
  "fieldVectorGlyphRequests",
  "fieldVectorShaderRequests",
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

function readFrontendMemorySnapshot(): FrontendAuditMemorySnapshot | null {
  if (typeof performance === "undefined") {
    return null;
  }
  const memory = (
    performance as Performance & {
      memory?: Partial<FrontendAuditMemorySnapshot>;
    }
  ).memory;
  if (!memory) {
    return null;
  }
  const usedJSHeapSize = Number(memory.usedJSHeapSize);
  const totalJSHeapSize = Number(memory.totalJSHeapSize);
  const jsHeapSizeLimit = Number(memory.jsHeapSizeLimit);
  if (
    !Number.isFinite(usedJSHeapSize) ||
    !Number.isFinite(totalJSHeapSize) ||
    !Number.isFinite(jsHeapSizeLimit)
  ) {
    return null;
  }
  return {
    usedJSHeapSize,
    totalJSHeapSize,
    jsHeapSizeLimit,
  };
}

function copyCounters(counters: FrontendAuditCounters): FrontendAuditCounters {
  return Object.fromEntries(
    COUNTER_NAMES.map((name) => [name, counters[name] ?? 0]),
  ) as FrontendAuditCounters;
}

function diffCounters(
  before: FrontendAuditCounters,
  after: FrontendAuditCounters,
): FrontendAuditCounters {
  return Object.fromEntries(
    COUNTER_NAMES.map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)]),
  ) as FrontendAuditCounters;
}

function copyNumberMap(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, Number.isFinite(value) ? value : 0]),
  );
}

function diffNumberMap(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries(
    Array.from(keys)
      .sort()
      .map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]),
  );
}

function attachFrontendAuditMethods(audit: FrontendAuditSnapshot): void {
  Object.defineProperty(audit, "snapshotDelta", {
    configurable: true,
    enumerable: false,
    value: async (seconds = 60): Promise<FrontendAuditDelta> => {
      const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 60;
      const startedAt = nowMs();
      const before = copyCounters(audit.counters);
      const beforeResourceFetches = copyNumberMap(audit.resourceFetches ?? {});
      const beforeMemory = readFrontendMemorySnapshot();
      await new Promise((resolve) => setTimeout(resolve, safeSeconds * 1000));
      const endedAt = nowMs();
      const afterMemory = readFrontendMemorySnapshot();
      const delta: FrontendAuditDelta = {
        seconds: safeSeconds,
        elapsedMs: endedAt - startedAt,
        counters: diffCounters(before, audit.counters),
        resourceFetches: diffNumberMap(beforeResourceFetches, audit.resourceFetches ?? {}),
        memory:
          beforeMemory && afterMemory
            ? {
                before: beforeMemory,
                after: afterMemory,
                deltaUsedJSHeapSize: afterMemory.usedJSHeapSize - beforeMemory.usedJSHeapSize,
                deltaTotalJSHeapSize: afterMemory.totalJSHeapSize - beforeMemory.totalJSHeapSize,
              }
            : null,
        webgl: audit.webgl.map((entry) => ({ ...entry })),
        startedAt,
        endedAt,
      };
      if (typeof console !== "undefined") {
        console.table(delta.counters);
        console.table(delta.resourceFetches);
        if (delta.memory) {
          console.table({
            deltaUsedJSHeapSize: delta.memory.deltaUsedJSHeapSize,
            deltaTotalJSHeapSize: delta.memory.deltaTotalJSHeapSize,
            afterUsedJSHeapSize: delta.memory.after.usedJSHeapSize,
            afterTotalJSHeapSize: delta.memory.after.totalJSHeapSize,
          });
        }
        console.log("[fullmag:audit] webgl", delta.webgl);
      }
      return delta;
    },
  });
}

export function ensureFrontendAudit(): FrontendAuditSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  const target = window as Window & { __FULLMAG_AUDIT__?: FrontendAuditSnapshot };
  if (!target.__FULLMAG_AUDIT__) {
    target.__FULLMAG_AUDIT__ = {
      counters: emptyCounters(),
      resourceFetches: {},
      webgl: [],
      marks: [],
      measures: [],
    } as unknown as FrontendAuditSnapshot;
  }
  target.__FULLMAG_AUDIT__.resourceFetches ??= {};
  if (typeof target.__FULLMAG_AUDIT__.snapshotDelta !== "function") {
    attachFrontendAuditMethods(target.__FULLMAG_AUDIT__);
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

export function incrementFrontendAuditResourceFetch(resource: string, delta = 1): void {
  const audit = ensureFrontendAudit();
  if (!audit) return;
  audit.counters.dataPlaneFetches = (audit.counters.dataPlaneFetches ?? 0) + delta;
  audit.resourceFetches[resource] = (audit.resourceFetches[resource] ?? 0) + delta;
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
