import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBinaryDecodeScheduler,
  disposeBinaryDecodeWorkerForTests,
} from "./binaryDecodeScheduler";
import type { BinaryDecodedPayload } from "./binaryDecodePayload";

type Listener = (event: Event | MessageEvent) => void;

class FakeBinaryDecodeWorker {
  static instances: FakeBinaryDecodeWorker[] = [];

  readonly listeners = new Map<string, Set<Listener>>();
  readonly postedMessages: unknown[] = [];
  terminated = false;

  constructor() {
    FakeBinaryDecodeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: Event | MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function messageEvent(data: unknown): MessageEvent {
  return { data } as MessageEvent;
}

describe("binaryDecodeScheduler", () => {
  afterEach(() => {
    disposeBinaryDecodeWorkerForTests();
    FakeBinaryDecodeWorker.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("terminates the decode worker after an idle window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeBinaryDecodeWorker);
    const scheduler = createBinaryDecodeScheduler();

    const result = scheduler({
      buffer: new ArrayBuffer(8),
      decodeInline: () => "inline",
      kind: "field-vector",
      path: "/binary",
    });

    const worker = FakeBinaryDecodeWorker.instances[0];
    expect(worker).toBeDefined();
    worker.emit(
      "message",
      messageEvent({
        data: "decoded" as unknown as BinaryDecodedPayload,
        id: 1,
        ok: true,
      }),
    );

    await expect(result).resolves.toBe("decoded");
    expect(worker.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(worker.terminated).toBe(true);
    expect(worker.listeners.get("message")?.size ?? 0).toBe(0);
    expect(worker.listeners.get("error")?.size ?? 0).toBe(0);
    expect(worker.listeners.get("messageerror")?.size ?? 0).toBe(0);
  });

  it("terminates a failed worker and recreates one for the next decode", async () => {
    vi.stubGlobal("Worker", FakeBinaryDecodeWorker);
    const scheduler = createBinaryDecodeScheduler();

    const failed = scheduler({
      buffer: new ArrayBuffer(8),
      decodeInline: () => "inline",
      kind: "field-vector",
      path: "/binary",
    });
    const firstWorker = FakeBinaryDecodeWorker.instances[0];
    firstWorker.emit("error", new Event("error"));

    await expect(failed).rejects.toMatchObject({
      name: "BinaryDecodeWorkerError",
    });
    expect(firstWorker.terminated).toBe(true);

    const recovered = scheduler({
      buffer: new ArrayBuffer(8),
      decodeInline: () => "inline",
      kind: "field-vector",
      path: "/binary",
    });
    const secondWorker = FakeBinaryDecodeWorker.instances[1];
    expect(secondWorker).toBeDefined();
    expect(secondWorker).not.toBe(firstWorker);
    secondWorker.emit(
      "message",
      messageEvent({
        data: "decoded-after-error" as unknown as BinaryDecodedPayload,
        id: 1,
        ok: true,
      }),
    );

    await expect(recovered).resolves.toBe("decoded-after-error");
  });

  it("emits decode diagnostics for inline decoding without a worker", async () => {
    vi.stubGlobal("Worker", undefined);
    const events: unknown[] = [];
    const scheduler = createBinaryDecodeScheduler({
      now: (() => {
        let current = 100;
        return () => current++;
      })(),
      onEvent: (event) => events.push(event),
    });

    await expect(
      scheduler({
        buffer: new ArrayBuffer(16),
        decodeInline: () => "inline",
        kind: "field-vector",
        path: "/v2/sessions/current/data/field-vector/m",
      }),
    ).resolves.toBe("inline");

    expect(events).toEqual([
      expect.objectContaining({
        errorName: null,
        kind: "field-vector",
        outcome: "ok",
        path: "/v2/sessions/current/data/field-vector/m",
        payloadBytes: 16,
        worker: false,
      }),
    ]);
  });

  it("emits decode diagnostics for worker transfer failures", async () => {
    vi.stubGlobal("Worker", FakeBinaryDecodeWorker);
    const events: unknown[] = [];
    const scheduler = createBinaryDecodeScheduler({
      onEvent: (event) => events.push(event),
    });

    const failed = scheduler({
      buffer: new ArrayBuffer(8),
      decodeInline: () => "inline",
      kind: "field-vector",
      path: "/binary",
    });
    const worker = FakeBinaryDecodeWorker.instances[0];
    worker.emit("messageerror", new Event("messageerror"));

    await expect(failed).rejects.toMatchObject({
      name: "BinaryDecodeWorkerError",
    });
    expect(events).toEqual([
      expect.objectContaining({
        errorName: "BinaryDecodeWorkerError",
        outcome: "error",
        payloadBytes: 8,
        worker: true,
      }),
    ]);
  });
});
