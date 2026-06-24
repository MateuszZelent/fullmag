import { recordViewport3DGpuUploadDiagnostic } from "./viewport3dGpuUploadDiagnostics";
import type {
  Viewport3DGpuUploadChunk,
  Viewport3DGpuUploadDiagnosticRecord,
  Viewport3DGpuUploadManager,
  Viewport3DGpuUploadPolicy,
  Viewport3DGpuUploadTicketInput,
} from "./viewport3dGpuUploadTypes";
import type { Viewport3DBuildJobKey } from "../viewport3dBuildEngineTypes";

const DEFAULT_VIEWPORT_3D_GPU_UPLOAD_POLICY: Viewport3DGpuUploadPolicy =
  {
    maxBytesPerSlice: 4 * 1024 * 1024,
    maxFrameBudgetMs: 5,
    maxItemsPerSlice: 50_000,
    targetFrameBudgetMs: 3,
  };

export interface Viewport3DGpuUploadManagerOptions {
  readonly cancelFrame?: (handle: unknown) => void;
  readonly now?: () => number;
  readonly onDiagnosticRecord?: (
    record: Viewport3DGpuUploadDiagnosticRecord,
  ) => void;
  readonly policy?: Partial<Viewport3DGpuUploadPolicy>;
  readonly scheduleFrame?: (callback: () => void) => unknown;
}

interface PendingViewport3DGpuUploadTicket {
  readonly chunks: readonly Viewport3DGpuUploadChunk[];
  readonly estimatedBytes: number;
  readonly key: Viewport3DBuildJobKey;
  readonly onVisible: () => void;
  readonly queuedAtMs: number;
  readonly signal?: AbortSignal;
  readonly targetRevision: string | null;
  readonly lane: Viewport3DGpuUploadTicketInput["lane"];
  abortListener: (() => void) | null;
  aborted: boolean;
  budgetExceeded: boolean;
  index: number;
  maxChunkMs: number;
  maxFrameUploadMs: number;
  mainUploadMs: number;
  uploadBytes: number;
  uploadChunks: number;
  uploadFrames: number;
}

export function createViewport3DGpuUploadManager({
  cancelFrame = defaultCancelFrame,
  now = defaultNow,
  onDiagnosticRecord,
  policy: policyPatch,
  scheduleFrame = defaultScheduleFrame,
}: Viewport3DGpuUploadManagerOptions = {}): Viewport3DGpuUploadManager {
  const policy = {
    ...DEFAULT_VIEWPORT_3D_GPU_UPLOAD_POLICY,
    ...policyPatch,
  };
  const queue: PendingViewport3DGpuUploadTicket[] = [];
  let disposed = false;
  let scheduledFrame: unknown = null;

  function enqueue(input: Viewport3DGpuUploadTicketInput): void {
    if (disposed) return;
    const ticket: PendingViewport3DGpuUploadTicket = {
      abortListener: null,
      aborted: Boolean(input.signal?.aborted),
      budgetExceeded: false,
      chunks: input.chunks,
      estimatedBytes: normalizeNonNegativeInteger(input.estimatedBytes),
      index: 0,
      key: input.key,
      lane: input.lane,
      maxChunkMs: 0,
      maxFrameUploadMs: 0,
      mainUploadMs: 0,
      onVisible: input.onVisible,
      queuedAtMs: now(),
      signal: input.signal,
      targetRevision: input.targetRevision,
      uploadBytes: 0,
      uploadChunks: 0,
      uploadFrames: 0,
    };
    if (input.signal) {
      ticket.abortListener = () => {
        ticket.aborted = true;
      };
      input.signal.addEventListener("abort", ticket.abortListener, {
        once: true,
      });
    }
    queue.push(ticket);
    schedule();
  }

  function abort(key: Viewport3DBuildJobKey): boolean {
    let aborted = false;
    for (const ticket of queue) {
      if (ticket.key !== key) continue;
      ticket.aborted = true;
      aborted = true;
    }
    return aborted;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (scheduledFrame !== null) {
      cancelFrame(scheduledFrame);
      scheduledFrame = null;
    }
    for (const ticket of queue.splice(0)) {
      ticket.aborted = true;
      cleanupTicket(ticket);
      recordTerminal(ticket, true);
    }
  }

  function schedule(): void {
    if (disposed || scheduledFrame !== null || queue.length === 0) return;
    scheduledFrame = scheduleFrame(runFrame);
  }

  function runFrame(): void {
    scheduledFrame = null;
    if (disposed) return;

    const ticket = queue[0];
    if (!ticket) return;
    if (ticket.aborted || ticket.signal?.aborted) {
      queue.shift();
      cleanupTicket(ticket);
      recordTerminal(ticket, true);
      schedule();
      return;
    }

    const frameStartMs = now();
    let frameBytes = 0;
    let frameItems = 0;
    let frameChunks = 0;

    while (ticket.index < ticket.chunks.length) {
      const chunk = ticket.chunks[ticket.index];
      if (!chunk) break;

      const chunkBytes = normalizeNonNegativeInteger(chunk.estimatedBytes);
      const chunkItems = normalizeNonNegativeInteger(chunk.itemCount);
      const hasUploadedInFrame = frameChunks > 0;
      if (
        hasUploadedInFrame &&
        (frameBytes + chunkBytes > normalizeBudget(policy.maxBytesPerSlice) ||
          frameItems + chunkItems > normalizeBudget(policy.maxItemsPerSlice))
      ) {
        break;
      }

      const chunkStartMs = now();
      chunk.upload();
      const chunkMs = Math.max(0, now() - chunkStartMs);
      ticket.maxChunkMs = Math.max(ticket.maxChunkMs, chunkMs);
      ticket.index += 1;
      ticket.uploadBytes += chunkBytes;
      ticket.uploadChunks += 1;
      frameBytes += chunkBytes;
      frameItems += chunkItems;
      frameChunks += 1;

      const frameElapsedMs = Math.max(0, now() - frameStartMs);
      if (
        frameElapsedMs >= normalizeBudget(policy.targetFrameBudgetMs) ||
        frameElapsedMs >= normalizeBudget(policy.maxFrameBudgetMs)
      ) {
        ticket.budgetExceeded =
          ticket.budgetExceeded ||
          frameElapsedMs > normalizeBudget(policy.maxFrameBudgetMs);
        break;
      }
    }

    if (frameChunks > 0) {
      const frameUploadMs = Math.max(0, now() - frameStartMs);
      ticket.uploadFrames += 1;
      ticket.mainUploadMs += frameUploadMs;
      ticket.maxFrameUploadMs = Math.max(
        ticket.maxFrameUploadMs,
        frameUploadMs,
      );
    }

    if (ticket.aborted || ticket.signal?.aborted) {
      queue.shift();
      cleanupTicket(ticket);
      recordTerminal(ticket, true);
      schedule();
      return;
    }

    if (ticket.index >= ticket.chunks.length) {
      queue.shift();
      cleanupTicket(ticket);
      ticket.onVisible();
      recordTerminal(ticket, false);
      schedule();
      return;
    }

    schedule();
  }

  function recordTerminal(
    ticket: PendingViewport3DGpuUploadTicket,
    aborted: boolean,
  ): void {
    const completedAtMs = now();
    const record: Viewport3DGpuUploadDiagnosticRecord = {
      aborted,
      budgetExceeded: ticket.budgetExceeded,
      completedAtMs,
      key: ticket.key,
      kind: "viewport-3d-gpu-upload",
      lane: ticket.lane,
      mainUploadMs: ticket.mainUploadMs,
      maxChunkMs: ticket.maxChunkMs,
      maxFrameUploadMs: ticket.maxFrameUploadMs,
      queuedAtMs: ticket.queuedAtMs,
      targetRevision: ticket.targetRevision,
      totalWallMs: Math.max(0, completedAtMs - ticket.queuedAtMs),
      uploadBytes: ticket.uploadBytes,
      uploadChunks: ticket.uploadChunks,
      uploadFrames: ticket.uploadFrames,
    };
    onDiagnosticRecord?.(record);
    recordViewport3DGpuUploadDiagnostic(record);
  }

  return {
    abort,
    dispose,
    enqueue,
  };
}

function cleanupTicket(ticket: PendingViewport3DGpuUploadTicket): void {
  if (ticket.signal && ticket.abortListener) {
    ticket.signal.removeEventListener("abort", ticket.abortListener);
    ticket.abortListener = null;
  }
}

function defaultScheduleFrame(callback: () => void): unknown {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(() => callback());
  }
  return setTimeout(callback, 16);
}

function defaultCancelFrame(handle: unknown): void {
  if (
    typeof handle === "number" &&
    typeof globalThis.cancelAnimationFrame === "function"
  ) {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function normalizeBudget(value: number): number {
  return Math.max(1, normalizeNonNegativeInteger(value));
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
