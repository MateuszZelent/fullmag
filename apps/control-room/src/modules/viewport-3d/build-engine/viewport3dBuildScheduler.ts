import type {
  Viewport3DBuildDiagnosticRecord,
  Viewport3DBuildFallbackSnapshot,
  Viewport3DBuildJobKey,
  Viewport3DBuildJobSnapshot,
  Viewport3DBuildLane,
  Viewport3DBuildRequest,
  Viewport3DBuildRunner,
  Viewport3DBuildScheduleOptions,
  Viewport3DBuildState,
} from "./viewport3dBuildEngineTypes";

export interface Viewport3DBuildScheduler {
  abortObsolete: (scope: Viewport3DBuildAbortScope) => void;
  dispose: () => void;
  schedule: <TResult>(
    request: Viewport3DBuildRequest,
    runner: Viewport3DBuildRunner<TResult>,
    options?: Viewport3DBuildScheduleOptions,
  ) => Promise<TResult>;
}

export interface Viewport3DBuildAbortScope {
  readonly exceptKey?: Viewport3DBuildJobKey;
  readonly groupKey?: string;
  readonly lane?: Viewport3DBuildLane;
}

export interface Viewport3DBuildSchedulerPolicy {
  readonly laneConcurrency?: Partial<Record<Viewport3DBuildLane, number>>;
  readonly now?: () => number;
  readonly onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  readonly onFallbackState?: (snapshot: Viewport3DBuildFallbackSnapshot) => void;
  readonly onJobState?: (snapshot: Viewport3DBuildJobSnapshot) => void;
}

interface PendingBuildJob {
  readonly abortController: AbortController;
  readonly key: Viewport3DBuildJobKey;
  readonly lane: Viewport3DBuildLane;
  readonly promise: Promise<unknown>;
  readonly queuedAtMs: number;
  readonly reject: (reason: unknown) => void;
  readonly request: Viewport3DBuildRequest;
  readonly resolve: (value: unknown) => void;
  readonly runner: Viewport3DBuildRunner<unknown>;
  externalAbortListener: (() => void) | null;
  fallbackReason: string | null;
  mainAdoptMs: number;
  options: Viewport3DBuildScheduleOptions;
  running: boolean;
  settled: boolean;
  startedAtMs: number | null;
  transferMs: number;
}

const DEFAULT_LANE_CONCURRENCY: Record<Viewport3DBuildLane, number> = {
  "binary-decode": 1,
  "bounds-hud": 1,
  "field-color": 1,
  "fdm-cuboid": 1,
  "gpu-upload": 1,
  "mesh-quality": 1,
  "region-overlay": 1,
  "topology-index": 1,
  "vector-glyph": 2,
};

export function createViewport3DBuildScheduler(
  policy: Viewport3DBuildSchedulerPolicy = {},
): Viewport3DBuildScheduler {
  const concurrency = {
    ...DEFAULT_LANE_CONCURRENCY,
    ...policy.laneConcurrency,
  };
  const activeByLane = new Map<Viewport3DBuildLane, number>();
  const fallbackCountsByLane = new Map<Viewport3DBuildLane, number>();
  const jobsByKey = new Map<Viewport3DBuildJobKey, PendingBuildJob>();
  const queuesByLane = new Map<Viewport3DBuildLane, PendingBuildJob[]>();
  const now = policy.now ?? defaultNow;
  let disposed = false;

  function schedule<TResult>(
    request: Viewport3DBuildRequest,
    runner: Viewport3DBuildRunner<TResult>,
    options: Viewport3DBuildScheduleOptions = {},
  ): Promise<TResult> {
    if (disposed) {
      return Promise.reject(createViewport3DBuildAbortError());
    }
    throwIfAborted(options.signal);
    const existing = jobsByKey.get(request.key);
    if (existing) {
      return existing.promise as Promise<TResult>;
    }
    if (options.latestWins && request.groupKey) {
      abortObsolete({
        exceptKey: request.key,
        groupKey: request.groupKey,
        lane: request.lane,
      });
    }

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const job: PendingBuildJob = {
      abortController: new AbortController(),
      externalAbortListener: null,
      fallbackReason: null,
      key: request.key,
      lane: request.lane,
      mainAdoptMs: 0,
      options,
      promise,
      queuedAtMs: now(),
      reject,
      request,
      resolve,
      runner: runner as Viewport3DBuildRunner<unknown>,
      running: false,
      settled: false,
      startedAtMs: null,
      transferMs: 0,
    };
    if (options.signal) {
      job.externalAbortListener = () => abortJob(job, false);
      options.signal.addEventListener("abort", job.externalAbortListener, {
        once: true,
      });
    }
    jobsByKey.set(request.key, job);
    publishJobState(job, "queued");
    queueForLane(request.lane).push(job);
    drainLane(request.lane);
    return promise as Promise<TResult>;
  }

  function abortObsolete(scope: Viewport3DBuildAbortScope): void {
    for (const job of Array.from(jobsByKey.values())) {
      if (scope.exceptKey && job.key === scope.exceptKey) continue;
      if (scope.lane && job.lane !== scope.lane) continue;
      if (scope.groupKey && job.request.groupKey !== scope.groupKey) continue;
      abortJob(job, true);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const job of Array.from(jobsByKey.values())) {
      abortJob(job, false);
    }
    queuesByLane.clear();
  }

  function drainLane(lane: Viewport3DBuildLane): void {
    if (disposed) return;
    const queue = queueForLane(lane);
    while (activeCount(lane) < concurrency[lane] && queue.length > 0) {
      const job = queue.shift();
      if (!job || job.settled) continue;
      startJob(job);
    }
  }

  function startJob(job: PendingBuildJob): void {
    job.running = true;
    job.startedAtMs = now();
    activeByLane.set(job.lane, activeCount(job.lane) + 1);
    publishJobState(job, "running");
    let result: Promise<unknown> | unknown;
    try {
      result = job.runner(job.request, {
        recordMainAdopt: (durationMs) => {
          job.mainAdoptMs += normalizeDurationMs(durationMs);
        },
        recordFallback: (reason) => {
          job.fallbackReason = reason;
          publishFallbackState(job, reason);
        },
        recordTransfer: (durationMs) => {
          job.transferMs += normalizeDurationMs(durationMs);
        },
        signal: job.abortController.signal,
      });
    } catch (error) {
      completeJob(job, error, undefined);
      return;
    }
    Promise.resolve(result).then(
      (value) => completeJob(job, null, value),
      (error) => completeJob(job, error, undefined),
    );
  }

  function completeJob(
    job: PendingBuildJob,
    error: unknown,
    result: unknown,
  ): void {
    if (job.settled) return;
    job.settled = true;
    cleanupJob(job);
    if (job.running) {
      activeByLane.set(job.lane, Math.max(activeCount(job.lane) - 1, 0));
    }
    if (error) {
      publishJobState(job, "failed");
      recordTerminalDiagnostic(job, "failed", false);
      job.reject(error);
    } else {
      publishJobState(job, "ready");
      recordTerminalDiagnostic(job, "ready", false);
      job.resolve(result);
    }
    drainLane(job.lane);
  }

  function abortJob(job: PendingBuildJob, obsolete: boolean): void {
    if (job.settled) return;
    job.settled = true;
    job.abortController.abort();
    removeQueuedJob(job);
    cleanupJob(job);
    if (job.running) {
      activeByLane.set(job.lane, Math.max(activeCount(job.lane) - 1, 0));
    }
    publishJobState(job, "aborted");
    recordTerminalDiagnostic(job, "aborted", obsolete);
    job.reject(createViewport3DBuildAbortError());
    drainLane(job.lane);
  }

  function cleanupJob(job: PendingBuildJob): void {
    jobsByKey.delete(job.key);
    if (job.options.signal && job.externalAbortListener) {
      job.options.signal.removeEventListener("abort", job.externalAbortListener);
      job.externalAbortListener = null;
    }
  }

  function removeQueuedJob(job: PendingBuildJob): void {
    const queue = queuesByLane.get(job.lane);
    if (!queue) return;
    const index = queue.indexOf(job);
    if (index >= 0) {
      queue.splice(index, 1);
    }
  }

  function queueForLane(
    lane: Viewport3DBuildLane,
  ): PendingBuildJob[] {
    const existing = queuesByLane.get(lane);
    if (existing) return existing;
    const queue: PendingBuildJob[] = [];
    queuesByLane.set(lane, queue);
    return queue;
  }

  function activeCount(lane: Viewport3DBuildLane): number {
    return activeByLane.get(lane) ?? 0;
  }

  function publishJobState(
    job: PendingBuildJob,
    state: Viewport3DBuildState,
  ): void {
    policy.onJobState?.({
      itemCount: job.request.itemCount,
      key: job.key,
      lane: job.lane,
      revisionSummary: job.request.revisionSummary,
      state,
    });
    job.options.onJobState?.({
      itemCount: job.request.itemCount,
      key: job.key,
      lane: job.lane,
      revisionSummary: job.request.revisionSummary,
      state,
    });
  }

  function publishFallbackState(
    job: PendingBuildJob,
    reason: string,
  ): void {
    const count = (fallbackCountsByLane.get(job.lane) ?? 0) + 1;
    fallbackCountsByLane.set(job.lane, count);
    const snapshot: Viewport3DBuildFallbackSnapshot = {
      count,
      key: job.key,
      lane: job.lane,
      reason,
      revisionSummary: job.request.revisionSummary,
      timestampMs: now(),
    };
    policy.onFallbackState?.(snapshot);
    job.options.onFallbackState?.(snapshot);
  }

  function recordTerminalDiagnostic(
    job: PendingBuildJob,
    state: Viewport3DBuildState,
    droppedBecauseObsolete: boolean,
  ): void {
    const finishedAtMs = now();
    const startedAtMs = job.startedAtMs ?? null;
    const queueWaitMs = Math.max(
      (startedAtMs ?? finishedAtMs) - job.queuedAtMs,
      0,
    );
    const workerComputeMs =
      startedAtMs === null ? 0 : Math.max(finishedAtMs - startedAtMs, 0);

    const record: Viewport3DBuildDiagnosticRecord = {
      abortedAtMs: state === "aborted" ? finishedAtMs : null,
      droppedBecauseObsolete,
      fallbackReason: job.fallbackReason,
      finishedAtMs,
      inputBytes: job.request.inputBytes,
      itemCount: job.request.itemCount,
      key: job.key,
      kind: "viewport-3d-build-job",
      lane: job.lane,
      mainAdoptMs: job.mainAdoptMs,
      mainUploadMs: 0,
      outputBytes: job.request.outputBytesEstimate,
      queuedAtMs: job.queuedAtMs,
      queueWaitMs,
      revisionSummary: job.request.revisionSummary,
      startedAtMs,
      state,
      totalWallMs: Math.max(finishedAtMs - job.queuedAtMs, 0),
      transferMs: job.transferMs,
      workerComputeMs,
    };
    policy.onDiagnosticRecord?.(record);
    job.options.onDiagnosticRecord?.(record);
  }

  return {
    abortObsolete,
    dispose,
    schedule,
  };
}

export function isViewport3DBuildAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "Viewport 3D build aborted")
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createViewport3DBuildAbortError();
  }
}

function createViewport3DBuildAbortError(): Error {
  const error = new Error("Viewport 3D build aborted");
  error.name = "AbortError";
  return error;
}

function defaultNow(): number {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

function normalizeDurationMs(durationMs: number): number {
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
}
