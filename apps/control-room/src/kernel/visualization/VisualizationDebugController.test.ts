import { describe, expect, it, vi } from "vitest";

import {
  MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES,
  VisualizationDebugController,
} from "./VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "./visualizationDebugTypes";

function makeSnapshot({
  capturedAtMs = 1,
  label = "Free layer",
  targetId = "object:free-layer",
  viewportId = "viewport-main",
}: {
  capturedAtMs?: number;
  label?: string;
  targetId?: string;
  viewportId?: string;
} = {}): VisualizationDebugSnapshot {
  return {
    capturedAtMs,
    carriers: [
      {
        cache: {
          byteLength: 96,
          entryState: "ready",
          etag: '"field-1"',
          fieldCacheByteLength: 96,
          fieldCacheEntryCount: 1,
          fieldCacheMaxBytes: 1024,
          retainCount: 1,
        },
        carrierId: "part:free-layer",
        carrierRole: "magnetic",
        memory: [],
        payload: {
          component: "full",
          dtype: "float64",
          formatVersion: 3,
          grid: [1, 1, 1],
          indexing: "implicit",
          nComp: 3,
          nodeIndexCount: null,
          pointCount: 1,
          quantityId: "m",
          scopeId: "free-layer",
          scopeKind: "object",
          valueCount: 3,
        },
        render: {
          adoption: {
            adoptedFieldBufferId: "field-buffer-1",
            adoptedScalarBufferKey: null,
            adoptedVectorBuildKey: "vectors-1",
            frameCommitId: "frame-1",
          },
          fieldBufferState: "ready",
          requestedPasses: ["vectors"],
          surface: {
            colorMode: null,
            degradation: null,
            projectionMode: null,
            scalarByteLength: null,
          },
          vectors: {
            buildKey: "vectors-1",
            degradation: null,
            segmentByteLength: 48,
            segmentCount: 1,
          },
        },
        request: {
          plannerRequestId: "request-1",
          resourceKey: "field:m?component=full&scope_kind=object",
        },
        revisions: {
          domainGenerationId: "domain-1",
          fieldRevision: "field-1",
          meshTopologyHash: "mesh-1",
          topologyRevision: "topology-1",
          visualizationRevision: "visualization-1",
        },
        samples: [
          {
            componentValues: [1, 0, 0],
            magnitude: 1,
            nodeIndex: null,
            pointIndex: 0,
          },
        ],
        scanState: "complete",
        statistics: [],
      },
    ],
    disposition: "ready",
    issues: [],
    sharedMemory: [],
    target: {
      carrierIds: ["part:free-layer"],
      id: targetId,
      kind: "object",
      label,
    },
    viewport: {
      contextLost: false,
      drawingBuffer: [1280, 720],
      frameCommittedAtMs: capturedAtMs,
      frameCommitId: "frame-1",
      viewportId,
    },
    version: 1,
  };
}

describe("VisualizationDebugController", () => {
  it("registers a publisher, commits a snapshot, and notifies its target subscriber", () => {
    const controller = new VisualizationDebugController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe("object:free-layer", listener);
    const token = controller.registerPublisher("viewport-main");

    controller.commit(token, "object:free-layer", makeSnapshot());

    expect(controller.getSnapshots("object:free-layer")).toHaveLength(1);
    expect(controller.getSnapshots("object:free-layer")[0]?.target.id).toBe(
      "object:free-layer",
    );
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("preserves snapshot-array references and does not notify for a semantic no-op", () => {
    const controller = new VisualizationDebugController();
    const listener = vi.fn();
    controller.subscribe("object:free-layer", listener);
    const token = controller.registerPublisher("viewport-main");

    controller.commit(token, "object:free-layer", makeSnapshot());
    const first = controller.getSnapshots("object:free-layer");
    controller.commit(token, "object:free-layer", makeSnapshot());

    expect(controller.getSnapshots("object:free-layer")).toBe(first);
    expect(controller.getSnapshots("object:free-layer")[0]).toBe(first[0]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not treat capture bookkeeping alone as new diagnostic evidence", () => {
    const controller = new VisualizationDebugController();
    const listener = vi.fn();
    controller.subscribe("object:free-layer", listener);
    const token = controller.registerPublisher("viewport-main");
    const firstInput = makeSnapshot();
    const secondInput = makeSnapshot();
    secondInput.capturedAtMs = firstInput.capturedAtMs + 1;

    controller.commit(token, "object:free-layer", firstInput);
    const first = controller.getSnapshots("object:free-layer");
    controller.commit(token, "object:free-layer", secondInput);

    expect(controller.getSnapshots("object:free-layer")).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reference-counts demand and returns idempotent release functions", () => {
    const controller = new VisualizationDebugController();
    const listener = vi.fn();
    controller.subscribeDemand("airbox", listener);

    const initial = controller.getDemandSnapshot("airbox");
    const releaseFirst = controller.request("airbox");
    const expanded = controller.getDemandSnapshot("airbox");
    const releaseSecond = controller.request("airbox");

    expect(initial).toEqual({ expanded: false, targetId: "airbox" });
    expect(expanded).toEqual({ expanded: true, targetId: "airbox" });
    expect(controller.getDemandSnapshot("airbox")).toBe(expanded);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(controller.getDemandSnapshot("airbox")).toBe(expanded);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseSecond();
    const collapsed = controller.getDemandSnapshot("airbox");
    expect(collapsed).toEqual({ expanded: false, targetId: "airbox" });
    expect(listener).toHaveBeenCalledTimes(2);

    releaseSecond();
    expect(controller.getDemandSnapshot("airbox")).toBe(collapsed);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clears retained snapshots when the final demand is released", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const release = controller.request("airbox");
    controller.commit(
      token,
      "airbox",
      makeSnapshot({ label: "Airbox", targetId: "airbox" }),
    );

    release();

    expect(controller.getSnapshots("airbox")).toHaveLength(0);
  });

  it("keeps only the two newest viewport snapshots for one target", () => {
    const controller = new VisualizationDebugController();

    for (const [index, viewportId] of ["viewport-a", "viewport-b", "viewport-c"].entries()) {
      const token = controller.registerPublisher(viewportId);
      controller.commit(
        token,
        "airbox",
        makeSnapshot({
          capturedAtMs: index + 1,
          label: "Airbox",
          targetId: "airbox",
          viewportId,
        }),
      );
    }

    expect(
      controller.getSnapshots("airbox").map((snapshot) => snapshot.viewport.viewportId),
    ).toEqual(["viewport-b", "viewport-c"]);
  });

  it("evicts the oldest non-demanded target before a demanded target", () => {
    const controller = new VisualizationDebugController();
    const release = controller.request("target:0");

    for (let index = 0; index < 9; index += 1) {
      const targetId = `target:${index}`;
      const viewportId = `viewport:${index}`;
      controller.commit(
        controller.registerPublisher(viewportId),
        targetId,
        makeSnapshot({ capturedAtMs: index, targetId, viewportId }),
      );
    }

    expect(controller.getSnapshots("target:0")).toHaveLength(1);
    expect(controller.getSnapshots("target:1")).toHaveLength(0);
    for (let index = 2; index < 9; index += 1) {
      expect(controller.getSnapshots(`target:${index}`)).toHaveLength(1);
    }

    release();
  });

  it("prevents stale publisher generations from committing or clearing", () => {
    const controller = new VisualizationDebugController();
    const oldToken = controller.registerPublisher("viewport-main");
    const currentToken = controller.registerPublisher("viewport-main");

    controller.commit(oldToken, "airbox", makeSnapshot({ targetId: "airbox" }));
    expect(controller.getSnapshots("airbox")).toHaveLength(0);

    controller.commit(
      currentToken,
      "airbox",
      makeSnapshot({ capturedAtMs: 2, targetId: "airbox" }),
    );
    const currentSnapshots = controller.getSnapshots("airbox");

    controller.clearPublisher(oldToken);
    expect(controller.getSnapshots("airbox")).toBe(currentSnapshots);

    controller.clearPublisher(currentToken);
    expect(controller.getSnapshots("airbox")).toHaveLength(0);
  });

  it("rejects typed arrays nested anywhere in a runtime snapshot", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const invalid = makeSnapshot() as unknown as {
      carriers: Array<{ samples: Array<{ componentValues: Float64Array }> }>;
    };
    invalid.carriers[0]!.samples[0]!.componentValues = new Float64Array([1, 2, 3]);

    expect(() =>
      controller.commit(
        token,
        "object:free-layer",
        invalid as unknown as VisualizationDebugSnapshot,
      ),
    ).toThrow(/typed array/i);
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
  });

  it("accepts shared references between otherwise plain bounded evidence rows", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot();
    const sharedMemoryRow = {
      byteLength: 48,
      id: "shared-vector-segments",
      label: "Vector segments",
      ownership: "shared" as const,
      source: "webgl-shared" as const,
    };
    input.sharedMemory = [sharedMemoryRow];
    input.carriers[0]!.memory = [sharedMemoryRow];

    expect(() => controller.commit(token, "object:free-layer", input)).not.toThrow();
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(1);
  });

  it("rejects enumerable toJSON hooks that hide oversized mutable evidence", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot();
    const hiddenMutable = { payload: "x".repeat(70_000) };
    Object.defineProperties(input, {
      hiddenMutable: {
        enumerable: true,
        value: hiddenMutable,
      },
      toJSON: {
        enumerable: true,
        value: () => ({ version: 1 }),
      },
    });

    expect(() => controller.commit(token, "object:free-layer", input)).toThrow(
      /toJSON|JSON-safe/i,
    );
    hiddenMutable.payload = "publisher-mutated-after-rejection";
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
  });

  it("rejects accessors without invoking their side effects", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot();
    let reads = 0;
    Object.defineProperty(input.target, "label", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "accessor label";
      },
    });

    expect(() => controller.commit(token, "object:free-layer", input)).toThrow(
      /accessor|JSON-safe/i,
    );
    expect(reads).toBe(0);
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
  });

  it.each([
    ["undefined", undefined],
    ["function", () => "unsafe"],
    ["symbol", Symbol("unsafe")],
    ["bigint", BigInt(1)],
  ])("rejects %s values instead of retaining JSON-divergent data", (_label, value) => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot() as VisualizationDebugSnapshot & {
      runtimeUnsafe?: unknown;
    };
    input.runtimeUnsafe = value;

    expect(() => controller.commit(token, "object:free-layer", input)).toThrow(
      /JSON-safe/i,
    );
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s as non-JSON-safe evidence",
    (value) => {
      const controller = new VisualizationDebugController();
      const token = controller.registerPublisher("viewport-main");
      const input = makeSnapshot();
      input.carriers[0]!.samples[0]!.componentValues = [value];

      expect(() => controller.commit(token, "object:free-layer", input)).toThrow(
        /finite|JSON-safe/i,
      );
      expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
    },
  );

  it("normalizes negative zero before measuring and retaining the frozen clone", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot();
    input.carriers[0]!.samples[0]!.componentValues = [-0];

    controller.commit(token, "object:free-layer", input);

    const retained = controller.getSnapshots("object:free-layer")[0]!;
    expect(Object.is(retained.carriers[0]!.samples[0]!.componentValues[0], 0)).toBe(
      true,
    );
  });

  it("rejects symbol-keyed and non-enumerable hidden state", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot();
    Object.defineProperty(input, Symbol("hidden"), {
      enumerable: true,
      value: "symbol-keyed",
    });
    Object.defineProperty(input, "nonEnumerableHidden", {
      enumerable: false,
      value: "not serialized",
    });

    expect(() => controller.commit(token, "object:free-layer", input)).toThrow(
      /JSON-safe/i,
    );
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
  });

  it("rejects cyclic evidence without retaining a partial clone", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot() as VisualizationDebugSnapshot & {
      cycle?: unknown;
    };
    input.cycle = input;

    expect(() => controller.commit(token, "object:free-layer", input)).toThrow(
      /acyclic|cycle|JSON-safe/i,
    );
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
  });

  it("rejects custom object and array prototypes", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const customObjectPrototype = makeSnapshot();
    Object.setPrototypeOf(customObjectPrototype.target, { custom: true });
    const customArrayPrototype = makeSnapshot();
    Object.setPrototypeOf(customArrayPrototype.issues, []);

    expect(() =>
      controller.commit(token, "object:free-layer", customObjectPrototype),
    ).toThrow(/custom.*prototype|JSON-safe/i);
    expect(() =>
      controller.commit(token, "object:free-layer", customArrayPrototype),
    ).toThrow(/custom.*prototype|JSON-safe/i);
    expect(controller.getSnapshots("object:free-layer")).toHaveLength(0);
  });

  it("replaces an oversized UTF-8 snapshot with a bounded size-limit issue", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const oversized = makeSnapshot({ label: "💾".repeat(20_000) });

    controller.commit(token, "object:free-layer", oversized);

    const [snapshot] = controller.getSnapshots("object:free-layer");
    expect(snapshot?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "snapshot-size-limit" }),
      ]),
    );
    expect(snapshot?.target.label).not.toBe(oversized.target.label);
    expect(
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
    ).toBeLessThanOrEqual(MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES);
  });

  it("stores a deeply immutable copy instead of retaining publisher-owned objects", () => {
    const controller = new VisualizationDebugController();
    const token = controller.registerPublisher("viewport-main");
    const input = makeSnapshot();

    controller.commit(token, "object:free-layer", input);
    const [stored] = controller.getSnapshots("object:free-layer");

    expect(stored).not.toBe(input);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.carriers)).toBe(true);
    expect(Object.isFrozen(stored?.carriers[0]?.samples[0]?.componentValues)).toBe(
      true,
    );
  });

  it("returns stable frozen empty snapshots for external-store server reads", () => {
    const controller = new VisualizationDebugController();

    const first = controller.getSnapshots("missing");
    const second = controller.getSnapshots("another-missing-target");

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
