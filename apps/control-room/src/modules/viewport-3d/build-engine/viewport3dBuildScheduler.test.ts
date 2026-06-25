import { describe, expect, it } from "vitest";

import {
  createViewport3DBuildScheduler,
  isViewport3DBuildAbortError,
} from "./viewport3dBuildScheduler";
import type {
  Viewport3DBuildDiagnosticRecord,
  Viewport3DBuildFallbackSnapshot,
  Viewport3DBuildJobSnapshot,
  Viewport3DBuildRequest,
  Viewport3DBuildRunner,
} from "./viewport3dBuildEngineTypes";

function buildRequest(
  key: string,
  groupKey = "field:m",
  patch: Partial<Viewport3DBuildRequest> = {},
): Viewport3DBuildRequest {
  return {
    groupKey,
    inputBytes: 0,
    itemCount: 1,
    key,
    lane: "vector-glyph",
    outputBytesEstimate: 0,
    revisionSummary: key,
    ...patch,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("viewport3dBuildScheduler", () => {
  it("dedupes identical pending jobs by key", async () => {
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 1 },
    });
    const pending = deferred<string>();
    let runCount = 0;
    const runner: Viewport3DBuildRunner<string> = () => {
      runCount += 1;
      return pending.promise;
    };

    const first = scheduler.schedule(buildRequest("vector:key-1"), runner);
    const second = scheduler.schedule(buildRequest("vector:key-1"), runner);

    expect(second).toBe(first);
    expect(runCount).toBe(1);

    pending.resolve("ready");
    await expect(first).resolves.toBe("ready");
    scheduler.dispose();
  });

  it("aborts the older job when a newer latest-wins job enters the same group", async () => {
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 1 },
    });
    const firstPending = deferred<string>();
    const secondPending = deferred<string>();
    let runCount = 0;
    const runner: Viewport3DBuildRunner<string> = () => {
      runCount += 1;
      return runCount === 1 ? firstPending.promise : secondPending.promise;
    };

    const first = scheduler.schedule(buildRequest("vector:field-1"), runner, {
      latestWins: true,
    });
    const second = scheduler.schedule(buildRequest("vector:field-2"), runner, {
      latestWins: true,
    });

    await expect(first).rejects.toSatisfy(isViewport3DBuildAbortError);
    secondPending.resolve("field-2");
    await expect(second).resolves.toBe("field-2");
    scheduler.dispose();
  });

  it("does not abort sibling latest-wins jobs in different groups", async () => {
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "field-color": 2 },
    });
    const pending = [deferred<string>(), deferred<string>()];
    let runIndex = 0;
    const runner: Viewport3DBuildRunner<string> = () => {
      const current = runIndex;
      runIndex += 1;
      return pending[current].promise;
    };

    const orientation = scheduler.schedule(
      buildRequest("field-color:orientation", "field-color:m:mode=orientation", {
        lane: "field-color",
      }),
      runner,
      { latestWins: true },
    );
    const x = scheduler.schedule(
      buildRequest("field-color:x", "field-color:m:mode=x", {
        lane: "field-color",
      }),
      runner,
      { latestWins: true },
    );

    pending[0]?.resolve("orientation");
    pending[1]?.resolve("x");

    await expect(orientation).resolves.toBe("orientation");
    await expect(x).resolves.toBe("x");
    scheduler.dispose();
  });

  it("bounds concurrent jobs by lane policy", async () => {
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 2 },
    });
    const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
    let active = 0;
    let maxActive = 0;
    let runIndex = 0;
    const runner: Viewport3DBuildRunner<string> = async () => {
      const current = runIndex;
      runIndex += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await pending[current].promise;
      } finally {
        active -= 1;
      }
    };

    const first = scheduler.schedule(buildRequest("vector:key-1", "g1"), runner);
    const second = scheduler.schedule(buildRequest("vector:key-2", "g2"), runner);
    const third = scheduler.schedule(buildRequest("vector:key-3", "g3"), runner);

    await Promise.resolve();
    expect(maxActive).toBe(2);
    expect(runIndex).toBe(2);

    pending[0].resolve("one");
    await expect(first).resolves.toBe("one");
    await Promise.resolve();

    expect(runIndex).toBe(3);
    pending[1].resolve("two");
    pending[2].resolve("three");
    await expect(second).resolves.toBe("two");
    await expect(third).resolves.toBe("three");
    expect(maxActive).toBe(2);
    scheduler.dispose();
  });

  it("rejects queued and running jobs when disposed", async () => {
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 1 },
    });
    const pending = deferred<string>();
    const runner: Viewport3DBuildRunner<string> = () => pending.promise;

    const first = scheduler.schedule(buildRequest("vector:key-1", "g1"), runner);
    const second = scheduler.schedule(buildRequest("vector:key-2", "g2"), runner);
    scheduler.dispose();

    await expect(first).rejects.toSatisfy(isViewport3DBuildAbortError);
    await expect(second).rejects.toSatisfy(isViewport3DBuildAbortError);
  });

  it("records job state snapshots and terminal timing diagnostics", async () => {
    let nowMs = 0;
    const records: Viewport3DBuildDiagnosticRecord[] = [];
    const snapshots: Viewport3DBuildJobSnapshot[] = [];
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 1 },
      now: () => nowMs,
      onDiagnosticRecord: (record) => records.push(record),
      onJobState: (snapshot) => snapshots.push(snapshot),
    });
    const pending = [deferred<string>(), deferred<string>()];
    let runIndex = 0;
    const runner: Viewport3DBuildRunner<string> = () =>
      pending[runIndex++].promise;

    nowMs = 10;
    const first = scheduler.schedule(
      buildRequest("vector:key-1", "g1", {
        inputBytes: 64,
        itemCount: 4,
        outputBytesEstimate: 128,
      }),
      runner,
    );
    nowMs = 20;
    const second = scheduler.schedule(
      buildRequest("vector:key-2", "g2", {
        inputBytes: 96,
        itemCount: 6,
        outputBytesEstimate: 192,
      }),
      runner,
    );

    nowMs = 60;
    pending[0].resolve("one");
    await expect(first).resolves.toBe("one");

    nowMs = 100;
    pending[1].resolve("two");
    await expect(second).resolves.toBe("two");
    scheduler.dispose();

    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "vector:key-1", state: "queued" }),
        expect.objectContaining({ key: "vector:key-1", state: "running" }),
        expect.objectContaining({ key: "vector:key-1", state: "ready" }),
        expect.objectContaining({ key: "vector:key-2", state: "queued" }),
        expect.objectContaining({ key: "vector:key-2", state: "running" }),
        expect.objectContaining({ key: "vector:key-2", state: "ready" }),
      ]),
    );
    expect(records).toEqual([
      expect.objectContaining({
        inputBytes: 64,
        itemCount: 4,
        key: "vector:key-1",
        outputBytes: 128,
        queueWaitMs: 0,
        state: "ready",
        totalWallMs: 50,
        workerComputeMs: 50,
      }),
      expect.objectContaining({
        inputBytes: 96,
        itemCount: 6,
        key: "vector:key-2",
        outputBytes: 192,
        queueWaitMs: 40,
        state: "ready",
        totalWallMs: 80,
        workerComputeMs: 40,
      }),
    ]);
  });

  it("accumulates runner-reported transfer and main adoption timings", async () => {
    let nowMs = 0;
    const records: Viewport3DBuildDiagnosticRecord[] = [];
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 1 },
      now: () => nowMs,
      onDiagnosticRecord: (record) => records.push(record),
    });
    const pending = deferred<string>();
    const runner: Viewport3DBuildRunner<string> = (_request, context) => {
      context.recordTransfer(3);
      context.recordTransfer(4);
      context.recordMainAdopt(2);
      context.recordMainAdopt(5);
      return pending.promise;
    };

    nowMs = 10;
    const result = scheduler.schedule(buildRequest("vector:timed"), runner);

    nowMs = 40;
    pending.resolve("ready");
    await expect(result).resolves.toBe("ready");
    scheduler.dispose();

    expect(records).toEqual([
      expect.objectContaining({
        key: "vector:timed",
        mainAdoptMs: 7,
        state: "ready",
        transferMs: 7,
        workerComputeMs: 30,
      }),
    ]);
  });

  it("records latest-wins aborts as obsolete diagnostic records", async () => {
    let nowMs = 0;
    const records: Viewport3DBuildDiagnosticRecord[] = [];
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 1 },
      now: () => nowMs,
      onDiagnosticRecord: (record) => records.push(record),
    });
    const firstPending = deferred<string>();
    const secondPending = deferred<string>();
    let runCount = 0;
    const runner: Viewport3DBuildRunner<string> = () => {
      runCount += 1;
      return runCount === 1 ? firstPending.promise : secondPending.promise;
    };

    nowMs = 5;
    const first = scheduler.schedule(buildRequest("vector:old"), runner, {
      latestWins: true,
    });
    nowMs = 25;
    const second = scheduler.schedule(buildRequest("vector:new"), runner, {
      latestWins: true,
    });
    secondPending.resolve("new");

    await expect(first).rejects.toSatisfy(isViewport3DBuildAbortError);
    await expect(second).resolves.toBe("new");
    scheduler.dispose();

    expect(records).toEqual([
      expect.objectContaining({
        droppedBecauseObsolete: true,
        key: "vector:old",
        state: "aborted",
        totalWallMs: 20,
        workerComputeMs: 20,
      }),
      expect.objectContaining({
        droppedBecauseObsolete: false,
        key: "vector:new",
        state: "ready",
      }),
    ]);
  });

  it("publishes worker fallback state as soon as a runner falls back", async () => {
    let nowMs = 0;
    const fallbacks: Viewport3DBuildFallbackSnapshot[] = [];
    const records: Viewport3DBuildDiagnosticRecord[] = [];
    const scheduler = createViewport3DBuildScheduler({
      laneConcurrency: { "vector-glyph": 1 },
      now: () => nowMs,
      onDiagnosticRecord: (record) => records.push(record),
      onFallbackState: (snapshot) => fallbacks.push(snapshot),
    });
    const pending = deferred<string>();
    const runner: Viewport3DBuildRunner<string> = (_request, context) => {
      context.recordFallback("worker-unavailable");
      return pending.promise;
    };

    nowMs = 10;
    const result = scheduler.schedule(
      buildRequest("vector:fallback", "field:m", {
        revisionSummary: "topology-1 field-1",
      }),
      runner,
    );

    expect(fallbacks).toEqual([
      {
        count: 1,
        key: "vector:fallback",
        lane: "vector-glyph",
        reason: "worker-unavailable",
        revisionSummary: "topology-1 field-1",
        timestampMs: 10,
      },
    ]);

    nowMs = 25;
    pending.resolve("ready-on-main");
    await expect(result).resolves.toBe("ready-on-main");
    expect(records).toEqual([
      expect.objectContaining({
        fallbackReason: "worker-unavailable",
        key: "vector:fallback",
        state: "ready",
      }),
    ]);
    scheduler.dispose();
  });
});
