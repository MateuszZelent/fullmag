import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildViewport3DVectorGlyphsOffMainThread,
  disposeVectorGlyphBuildWorkerForTests,
} from "./vectorGlyphBuildScheduler";
import type { Viewport3DBuildDiagnosticRecord } from "../build-engine/viewport3dBuildEngineTypes";

function installPendingWorkerStub(): {
  readonly instances: Array<{
    readonly listeners: Map<string, Set<EventListener>>;
    readonly postMessage: ReturnType<typeof vi.fn>;
    readonly terminate: ReturnType<typeof vi.fn>;
  }>;
} {
  class PendingWorker {
    static instances: PendingWorker[] = [];

    readonly listeners = new Map<string, Set<EventListener>>();
    postMessage = vi.fn();
    terminate = vi.fn();

    constructor() {
      PendingWorker.instances.push(this);
    }

    addEventListener(type: string, listener: EventListener): void {
      const listeners = this.listeners.get(type) ?? new Set<EventListener>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: EventListener): void {
      this.listeners.get(type)?.delete(listener);
    }
  }

  vi.stubGlobal("Worker", PendingWorker);

  return {
    get instances() {
      return PendingWorker.instances;
    },
  };
}

describe("vectorGlyphBuildScheduler", () => {
  afterEach(() => {
    disposeVectorGlyphBuildWorkerForTests();
    vi.unstubAllGlobals();
  });

  it("falls back to the shared glyph builder when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    const result = await buildViewport3DVectorGlyphsOffMainThread({
      colorMode: "x",
      headRadiusRatio: 0.2,
      segments: new Float32Array([
        0, 0, 0, 2, 0, 0, 1,
        0, 0, 0, 0, 3, 0, 0.5,
      ]),
      shaftRadiusRatio: 0.08,
    }, {
      buildKey: "vector-glyph:fallback-worker-unavailable",
      onDiagnosticRecord: (record) => records.push(record),
    });

    expect(result.transforms.count).toBe(2);
    expect(Array.from(result.transforms.directions)).toEqual([
      1, 0, 0,
      0, 1, 0,
    ]);
    expect(result.colors).toBeInstanceOf(Float32Array);
    expect(result.colors?.length).toBe(6);
    expect(records).toEqual([
      expect.objectContaining({
        fallbackReason: "worker-unavailable",
        key: "vector-glyph:fallback-worker-unavailable",
        state: "ready",
      }),
    ]);
  });

  it("transfers glyph input and output buffers through the worker path", () => {
    const schedulerSource = readFileSync(
      new URL("./vectorGlyphBuildScheduler.ts", import.meta.url),
      "utf8",
    );
    const workerSource = readFileSync(
      new URL("./vectorGlyphBuildWorker.ts", import.meta.url),
      "utf8",
    );

    expect(schedulerSource).toContain(
      "lease.worker.postMessage(request, transferables)",
    );
    expect(schedulerSource).toContain("addArrayBufferTransferable");
    expect(workerSource).toContain(
      "transferablesForVectorGlyphBuildResult(result)",
    );
  });

  it("keeps pure glyph build logic out of the client worker scheduler", () => {
    const workerSource = readFileSync(
      new URL("./vectorGlyphBuildWorker.ts", import.meta.url),
      "utf8",
    );

    expect(workerSource).toContain("./vectorGlyphBuildModel");
    expect(workerSource).not.toContain("./vectorGlyphBuildScheduler");
  });

  it("publishes build-engine diagnostics through the viewport diagnostic bridge", () => {
    const schedulerSource = readFileSync(
      new URL("./vectorGlyphBuildScheduler.ts", import.meta.url),
      "utf8",
    );

    expect(schedulerSource).toContain("recordViewport3DBuildDiagnostic");
    expect(schedulerSource).toContain(
      "onDiagnosticRecord: recordViewport3DBuildDiagnostic",
    );
  });

  it("dedupes pending vector glyph builds with the same build-engine key", async () => {
    const pendingWorker = installPendingWorkerStub();

    const request = {
      colorMode: "x" as const,
      headRadiusRatio: 0.2,
      segments: new Float32Array([
        0, 0, 0, 2, 0, 0, 1,
        0, 0, 0, 0, 3, 0, 0.5,
      ]),
      shaftRadiusRatio: 0.08,
    };
    const first = buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: "vector-glyph:topology-1:field-1",
      groupKey: "vector-glyph:field",
      latestWins: true,
    }).catch((error: unknown) => error);
    const second = buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: "vector-glyph:topology-1:field-1",
      groupKey: "vector-glyph:field",
      latestWins: true,
    }).catch((error: unknown) => error);

    expect(pendingWorker.instances).toHaveLength(1);
    expect(pendingWorker.instances[0].postMessage).toHaveBeenCalledTimes(1);

    disposeVectorGlyphBuildWorkerForTests();
    await Promise.all([first, second]);
  });

  it("uses two vector workers for two different concurrent build-engine jobs", async () => {
    const pendingWorker = installPendingWorkerStub();

    const request = {
      colorMode: "x" as const,
      headRadiusRatio: 0.2,
      segments: new Float32Array([
        0, 0, 0, 2, 0, 0, 1,
        0, 0, 0, 0, 3, 0, 0.5,
      ]),
      shaftRadiusRatio: 0.08,
    };
    const first = buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: "vector-glyph:topology-1:field-1:part-a",
      groupKey: "vector-glyph:field:part-a",
    }).catch((error: unknown) => error);
    const second = buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: "vector-glyph:topology-1:field-1:part-b",
      groupKey: "vector-glyph:field:part-b",
    }).catch((error: unknown) => error);

    expect(pendingWorker.instances).toHaveLength(2);
    expect(pendingWorker.instances[0].postMessage).toHaveBeenCalledTimes(1);
    expect(pendingWorker.instances[1].postMessage).toHaveBeenCalledTimes(1);

    disposeVectorGlyphBuildWorkerForTests();
    await Promise.all([first, second]);
  });

  it("caps the vector worker pool at two active workers", async () => {
    const pendingWorker = installPendingWorkerStub();

    const request = {
      colorMode: "x" as const,
      headRadiusRatio: 0.2,
      segments: new Float32Array([
        0, 0, 0, 2, 0, 0, 1,
        0, 0, 0, 0, 3, 0, 0.5,
      ]),
      shaftRadiusRatio: 0.08,
    };
    const first = buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: "vector-glyph:topology-1:field-1:part-a",
      groupKey: "vector-glyph:field:part-a",
    }).catch((error: unknown) => error);
    const second = buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: "vector-glyph:topology-1:field-1:part-b",
      groupKey: "vector-glyph:field:part-b",
    }).catch((error: unknown) => error);
    const third = buildViewport3DVectorGlyphsOffMainThread(request, {
      buildKey: "vector-glyph:topology-1:field-1:part-c",
      groupKey: "vector-glyph:field:part-c",
    }).catch((error: unknown) => error);

    expect(pendingWorker.instances).toHaveLength(2);
    expect(
      pendingWorker.instances.reduce(
        (total, worker) => total + worker.postMessage.mock.calls.length,
        0,
      ),
    ).toBe(2);

    disposeVectorGlyphBuildWorkerForTests();
    await Promise.all([first, second, third]);
  });
});
