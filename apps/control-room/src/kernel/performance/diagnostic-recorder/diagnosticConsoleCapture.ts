import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticConsoleRecord,
  type DiagnosticRecordDetail,
  type DiagnosticViewport3DRecord,
  redactDiagnosticDetail,
} from "./diagnosticRecorderTypes";

type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleLike {
  error: ConsoleMethod;
  warn: ConsoleMethod;
}

interface DiagnosticConsoleCaptureTarget {
  addEventListener?(
    type: "error" | "unhandledrejection",
    listener: EventListener,
  ): void;
  console?: ConsoleLike;
  removeEventListener?(
    type: "error" | "unhandledrejection",
    listener: EventListener,
  ): void;
}

interface ErrorEventLike extends Event {
  colno?: number;
  error?: unknown;
  filename?: string;
  lineno?: number;
  message?: string;
}

interface PromiseRejectionEventLike extends Event {
  reason?: unknown;
}

export interface DiagnosticConsoleCaptureOptions {
  now?: () => number;
  record: (record: DiagnosticConsoleRecord | DiagnosticViewport3DRecord) => void;
  target?: DiagnosticConsoleCaptureTarget | null;
}

export interface DiagnosticWebGLContextRecordInput {
  contextLost: boolean;
  detail?: Record<string, unknown>;
  dirtyReason?: string | null;
  drawingBufferHeight?: number | null;
  drawingBufferWidth?: number | null;
  geometries?: number;
  materials?: number;
  renderTargets?: number;
  textures?: number;
  timestampMs?: number;
  workers?: number;
}

const MAX_MESSAGE_LENGTH = 4_000;

export function installDiagnosticConsoleCapture({
  now = Date.now,
  record,
  target = defaultConsoleCaptureTarget(),
}: DiagnosticConsoleCaptureOptions): () => void {
  if (!target) return () => {};

  const consoleTarget = target.console;
  const originalError = consoleTarget?.error;
  const originalWarn = consoleTarget?.warn;
  const patchedError =
    originalError &&
    ((...args: unknown[]) => {
      record(createConsoleRecord("error", args, "console.error", now()));
      originalError(...args);
    });
  const patchedWarn =
    originalWarn &&
    ((...args: unknown[]) => {
      record(createConsoleRecord("warn", args, "console.warn", now()));
      originalWarn(...args);
    });

  if (consoleTarget && patchedError) {
    consoleTarget.error = patchedError;
  }
  if (consoleTarget && patchedWarn) {
    consoleTarget.warn = patchedWarn;
  }

  const onError: EventListener = (event) => {
    record(createErrorEventRecord(event as ErrorEventLike, now()));
  };
  const onUnhandledRejection: EventListener = (event) => {
    record(createUnhandledRejectionRecord(event as PromiseRejectionEventLike, now()));
  };

  target.addEventListener?.("error", onError);
  target.addEventListener?.("unhandledrejection", onUnhandledRejection);

  return () => {
    if (consoleTarget && originalError && consoleTarget.error === patchedError) {
      consoleTarget.error = originalError;
    }
    if (consoleTarget && originalWarn && consoleTarget.warn === patchedWarn) {
      consoleTarget.warn = originalWarn;
    }
    target.removeEventListener?.("error", onError);
    target.removeEventListener?.("unhandledrejection", onUnhandledRejection);
  };
}

export function createDiagnosticWebGLContextRecord({
  contextLost,
  detail = {},
  dirtyReason = null,
  drawingBufferHeight = null,
  drawingBufferWidth = null,
  geometries = 0,
  materials = 0,
  renderTargets = 0,
  textures = 0,
  timestampMs = Date.now(),
  workers = 0,
}: DiagnosticWebGLContextRecordInput): DiagnosticViewport3DRecord {
  return {
    byteLength: null,
    contextLost,
    detail: redactDiagnosticDetail({
      ...detail,
      drawingBufferHeight,
      drawingBufferWidth,
    }),
    dirtyReason,
    droppedCount: 0,
    durationMs: null,
    geometries,
    id: "",
    kind: "webgl-context",
    lane: "webgl",
    materials,
    name: contextLost
      ? DIAGNOSTIC_EVENT_NAMES.viewport3DContextLost
      : DIAGNOSTIC_EVENT_NAMES.viewport3DContextRestored,
    renderTargets,
    severity: contextLost ? "critical" : "info",
    startTimeMs: null,
    textures,
    timestampMs,
    workers,
  };
}

function createConsoleRecord(
  level: DiagnosticConsoleRecord["level"],
  args: unknown[],
  source: string,
  timestampMs: number,
): DiagnosticConsoleRecord {
  const message = formatConsoleMessage(args);
  return {
    byteLength: null,
    detail: redactDiagnosticDetail({
      argumentCount: args.length,
      source,
    }),
    droppedCount: 0,
    durationMs: null,
    id: "",
    kind: "console",
    lane: "console",
    level,
    message,
    name: source,
    severity: level === "error" ? "critical" : "warning",
    source,
    startTimeMs: null,
    timestampMs,
  };
}

function createErrorEventRecord(
  event: ErrorEventLike,
  timestampMs: number,
): DiagnosticConsoleRecord {
  const message = event.message || formatUnknown(event.error) || "window error";
  const detail: DiagnosticRecordDetail = redactDiagnosticDetail({
    colno: normalizeNumber(event.colno),
    filename: event.filename ?? null,
    lineno: normalizeNumber(event.lineno),
    source: "window.error",
  });
  return {
    byteLength: null,
    detail,
    droppedCount: 0,
    durationMs: null,
    id: "",
    kind: "page-error",
    lane: "console",
    level: "error",
    message: truncateMessage(message),
    name: "window.error",
    severity: "critical",
    source: event.filename ?? null,
    startTimeMs: null,
    timestampMs,
  };
}

function createUnhandledRejectionRecord(
  event: PromiseRejectionEventLike,
  timestampMs: number,
): DiagnosticConsoleRecord {
  return {
    byteLength: null,
    detail: redactDiagnosticDetail({ source: "window.unhandledrejection" }),
    droppedCount: 0,
    durationMs: null,
    id: "",
    kind: "unhandled-rejection",
    lane: "console",
    level: "error",
    message: truncateMessage(
      formatUnknown(event.reason) || "unhandled promise rejection",
    ),
    name: "window.unhandledrejection",
    severity: "critical",
    source: "window.unhandledrejection",
    startTimeMs: null,
    timestampMs,
  };
}

function formatConsoleMessage(args: unknown[]): string {
  return truncateMessage(args.map(formatUnknown).join(" "));
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function normalizeNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncateMessage(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...`
    : message;
}

function defaultConsoleCaptureTarget(): DiagnosticConsoleCaptureTarget | null {
  return typeof window === "undefined"
    ? null
    : (window as unknown as DiagnosticConsoleCaptureTarget);
}
