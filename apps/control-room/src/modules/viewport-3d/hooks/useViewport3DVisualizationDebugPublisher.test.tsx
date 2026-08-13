import { describe, expect, it, vi } from "vitest";

import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import type {
  VisualizationDebugNumericStats,
  VisualizationDebugSnapshot,
} from "@/kernel/visualization/visualizationDebugTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import {
  canonicalFieldVectorQuery,
  serializeCanonicalFieldVectorResourceKey,
} from "@/kernel/api/fieldQueryIdentity";

import { createViewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import { buildViewport3DTargetFieldBuffer } from "../model/viewport3DTargetFieldBuffer";
import { recordFdmCuboidSurfaceAdoption } from "../layers/FdmCuboidLayer";
import { recordMeshPartSurfaceAdoption } from "../layers/MeshPartLayer";
import { resolveViewport3DScalarColorBufferKey } from "../viewport3dFieldMapping";
import {
  createViewport3DVisualizationDebugPublisher,
  createViewport3DVisualizationDebugCandidateBuilder,
  groupViewport3DVisualizationDebugCarriers,
  type Viewport3DVisualizationDebugCandidate,
  type Viewport3DVisualizationDebugFrameCommit,
  type Viewport3DVisualizationDebugSource,
} from "./useViewport3DVisualizationDebugPublisher";
import type { Viewport3DRenderAdoptionReceipt } from "../model/viewport3DRenderAdoptionRegistry";

function snapshot(targetId: string, frameCommitId: string): VisualizationDebugSnapshot {
  return {
    capturedAtMs: 1,
    carriers: [],
    disposition: "ready",
    issues: [],
    memoryTotals: { owned: 0, referenced: 0, shared: 0 },
    ownedByteLength: 0,
    sharedMemory: [],
    target: { carrierIds: [], id: targetId, kind: "object", label: targetId },
    version: 1,
    viewport: {
      contextLost: false,
      drawingBuffer: [640, 480],
      frameCommittedAtMs: 2,
      frameCommitId,
      viewportId: "viewport-main",
    },
  };
}

async function settleCandidate(
  candidate: Viewport3DVisualizationDebugCandidate,
): Promise<void> {
  candidate.start?.();
  await Promise.resolve();
  await Promise.resolve();
}

function syntheticScanSource({
  exactRange = false,
}: {
  exactRange?: boolean;
} = {}): Viewport3DVisualizationDebugSource {
  const values = new Float64Array([1, 2, 3, 4, 5, 6]);
  const fieldBuffer = {
    bufferId: "synthetic:airbox:vectors",
    capability: "synthetic-full-vector" as const,
    component: "full" as const,
    componentCount: 3,
    consumers: [],
    currentDomainGenerationId: null,
    currentMeshTopologyHash: null,
    decodedFieldVector: null,
    domainGenerationId: null,
    fieldRevision: null,
    indexing: "legacy_count_only" as const,
    meshTopologyHash: null,
    nodeIndexCount: null,
    nodeIndices: null,
    pointCount: 2,
    quantityId: "synthetic-airbox",
    requestId: null,
    resourceKey: null,
    sampled: false,
    scopeId: "part:__air__",
    scopeKind: "airbox" as const,
    topologyRevision: null,
    values,
    vectorComponentCount: 3,
  };
  return {
    carrierRoles: new Map([["part:__air__", "air"]]),
    fieldModel: {
      complexFieldVector: null,
      derivedWorkItems: [],
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map(),
      scalarColors: null,
      scalarColorsByMode: new Map(),
      scalarColorsByPartAndMode: new Map(),
      targetDiagnostics: [],
      targetPasses: new Map([
        [
          "part:__air__",
          {
            fieldBuffer,
            fieldBufferState: "target-buffer" as const,
            surface: {
              degradation: null,
              passId: "part:__air__:surface",
              scalarColorMode: exactRange ? "x" : null,
              scalarColors: exactRange
                ? {
                    buildKey: "scalar:airbox:x",
                    colors: new Float32Array([0, 1]),
                    colorMode: "x",
                    quantityId: "synthetic-airbox",
                    range: { max: 4, min: 1 },
                    rangeDiagnostics: {
                      finiteCount: 2,
                      max: 4,
                      mean: 2.5,
                      min: 1,
                      nonFiniteCount: 0,
                      outlierDominated: false,
                      p01: 1,
                      p99: 4,
                      zeroCount: 0,
                    },
                  }
                : null,
            },
            vectors: {
              buildReference: null,
              degradation: null,
              passId: "part:__air__:vector-glyph",
              segments: exactRange
                ? null
                : new Float32Array([0, 0, 0, 1, 0, 0, 0]),
            },
          },
        ],
      ]),
      visualizationPhaseRad: null,
    },
    fullFieldVector: null,
    targets: [
      {
        carrierIds: ["part:__air__"],
        target: { id: "airbox", kind: "airbox", label: "Airbox" },
      },
    ],
    topologyByteLength: null,
    visualizationRevision: "viz-1",
    webglSharedByteLength: null,
  };
}

describe("viewport visualization debug publisher", () => {
  it("does not build, scan, or publish while debug demand is closed", async () => {
    const controller = new VisualizationDebugController();
    const buildCandidate = vi.fn();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate,
      controller,
      viewportId: "viewport-main",
    });

    publisher.update({ revision: "field-1", targetIds: ["airbox"] });
    publisher.commitFrame({ commitId: "frame-1" });
    await Promise.resolve();

    expect(buildCandidate).not.toHaveBeenCalled();
    expect(controller.getSnapshots("airbox")).toEqual([]);
    publisher.dispose();
  });

  it("keeps candidates private until frame commit and includes current adoption receipts", async () => {
    const controller = new VisualizationDebugController();
    const registry = createViewport3DRenderAdoptionRegistry();
    const buildCandidate = vi.fn(async ({ targetId }) => ({
      materialize: ({ frame, receipts }: {
        frame: Viewport3DVisualizationDebugFrameCommit;
        receipts: readonly Viewport3DRenderAdoptionReceipt[];
      }) => {
        expect(receipts.map((receipt) => receipt.scalarBufferKey)).toEqual(["scalar-adopted"]);
        return snapshot(targetId, frame.commitId);
      },
    }));
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: registry,
      buildCandidate,
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("airbox");
    publisher.update({ revision: "field-1", targetIds: ["airbox"] });
    await Promise.resolve();
    registry.recordSurfaceAdoption({
      byteLength: 24,
      carrierId: "part:__air__",
      fieldBufferId: "requested-field",
      scalarBufferKey: "scalar-adopted",
      targetId: "airbox",
    });

    const listener = vi.fn();
    const unsubscribe = controller.subscribe("airbox", listener);
    expect(controller.getSnapshots("airbox")).toEqual([]);
    publisher.commitFrame({ commitId: "frame-1" });
    expect(controller.getSnapshots("airbox")[0]?.viewport.frameCommitId).toBe("frame-1");
    publisher.commitFrame({ commitId: "frame-1" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    release();
    publisher.dispose();
  });

  it("aborts stale scans on revision change and never publishes their late result", async () => {
    const controller = new VisualizationDebugController();
    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: Viewport3DVisualizationDebugCandidate) => void> = [];
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: ({ signal }) => {
        signals.push(signal);
        return new Promise((resolve) => resolvers.push(resolve));
      },
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("object:a");
    publisher.update({ revision: "field-1", targetIds: ["object:a"] });
    publisher.update({ revision: "field-2", targetIds: ["object:a"] });

    expect(signals[0]?.aborted).toBe(true);
    resolvers[0]?.({ materialize: () => snapshot("object:a", "stale") });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-2" });
    expect(controller.getSnapshots("object:a")).toEqual([]);

    resolvers[1]?.({ materialize: ({ frame }) => snapshot("object:a", frame.commitId) });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-2" });
    expect(controller.getSnapshots("object:a")[0]?.viewport.frameCommitId).toBe("frame-2");
    release();
    publisher.dispose();
  });

  it("release and unmount abort scans, clear snapshots, and reject late publication", async () => {
    const controller = new VisualizationDebugController();
    let resolveCandidate!: (value: Viewport3DVisualizationDebugCandidate) => void;
    let signal!: AbortSignal;
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: ({ signal: candidateSignal }) => {
        signal = candidateSignal;
        return new Promise((resolve) => { resolveCandidate = resolve; });
      },
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("airbox");
    publisher.update({ revision: "field-1", targetIds: ["airbox"] });
    release();
    expect(signal.aborted).toBe(true);
    resolveCandidate({ materialize: () => snapshot("airbox", "late") });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-late" });
    expect(controller.getSnapshots("airbox")).toEqual([]);

    const releaseAgain = controller.request("airbox");
    publisher.update({ revision: "field-2", targetIds: ["airbox"] });
    publisher.dispose();
    expect(controller.getSnapshots("airbox")).toEqual([]);
    releaseAgain();
  });

  it("removing an available target clears its published snapshot and aborts its publisher work", async () => {
    const controller = new VisualizationDebugController();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: async ({ targetId }) => ({
        materialize: ({ frame }) => snapshot(targetId, frame.commitId),
      }),
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("object:a");
    publisher.update({ revision: "field-1", targetIds: ["object:a"] });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-1" });
    expect(controller.getSnapshots("object:a")).toHaveLength(1);

    publisher.update({ revision: "field-1", targetIds: [] });
    expect(controller.getSnapshots("object:a")).toEqual([]);
    release();
    publisher.dispose();
  });

  it("publishes late Inspector demand against the latest frame without an extra render", async () => {
    const controller = new VisualizationDebugController();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: async ({ targetId }) => ({
        materialize: ({ frame }) => snapshot(targetId, frame.commitId),
      }),
      controller,
      viewportId: "viewport-main",
    });
    publisher.update({ revision: "field-1", targetIds: ["airbox"] });
    publisher.commitFrame({ commitId: "frame-before-demand" });

    const release = controller.request("airbox");
    await Promise.resolve();

    expect(controller.getSnapshots("airbox")[0]?.viewport.frameCommitId).toBe(
      "frame-before-demand",
    );
    release();
    publisher.dispose();
  });

  it("aborts pending candidate work when its logical target is removed", () => {
    const controller = new VisualizationDebugController();
    const candidateSignals: AbortSignal[] = [];
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: ({ signal }) => {
        candidateSignals.push(signal);
        return new Promise(() => {});
      },
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("object:a");
    publisher.update({ revision: "field-1", targetIds: ["object:a"] });

    publisher.update({ revision: "field-1", targetIds: [] });

    expect(candidateSignals[0]?.aborted).toBe(true);
    expect(controller.getSnapshots("object:a")).toEqual([]);
    release();
    publisher.dispose();
  });

  it("keeps semantic no-op frame commits passive", async () => {
    const controller = new VisualizationDebugController();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: async ({ targetId }) => ({
        materialize: () => snapshot(targetId, "same-frame"),
      }),
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("object:a");
    publisher.update({ revision: "field-1", targetIds: ["object:a"] });
    await Promise.resolve();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe("object:a", listener);

    publisher.commitFrame({ commitId: "frame-a" });
    publisher.commitFrame({ commitId: "frame-b" });

    expect(listener).toHaveBeenCalledTimes(1);
    const publisherSource = readFileSync(
      fileURLToPath(new URL("./useViewport3DVisualizationDebugPublisher.ts", import.meta.url)),
      "utf8",
    );
    expect(publisherSource).not.toContain("invalidate(");
    expect(publisherSource).not.toContain("recordDirtyFrame(");
    unsubscribe();
    release();
    publisher.dispose();
  });

  it("commits no stale adoption on the frame after exact layer cleanup", async () => {
    const controller = new VisualizationDebugController();
    const registry = createViewport3DRenderAdoptionRegistry();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: registry,
      buildCandidate: async ({ targetId }) => ({
        materialize: ({ frame, receipts }) => ({
          ...snapshot(targetId, frame.commitId),
          ownedByteLength: receipts.length,
        }),
      }),
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("object:a");
    publisher.update({
      carrierTargets: new Map([["part:a", ["object:a"]]]),
      revision: "field-1",
      targetIds: ["object:a"],
    });
    await Promise.resolve();
    const adoption = {
      carrierId: "part:a",
      fieldBufferId: "field-a",
      kind: "surface" as const,
      resourceKey: "resource-a",
      scalarBufferKey: "scalar-a",
      vectorBuildKey: null,
    };
    registry.recordSurfaceAdoption({
      byteLength: 12,
      carrierId: adoption.carrierId,
      fieldBufferId: adoption.fieldBufferId,
      resourceKey: adoption.resourceKey,
      scalarBufferKey: adoption.scalarBufferKey,
    });
    publisher.commitFrame({ commitId: "frame-adopted" });
    expect(controller.getSnapshots("object:a")[0]?.ownedByteLength).toBe(1);

    registry.clearAdoption(adoption);
    publisher.commitFrame({ commitId: "frame-clean" });

    expect(controller.getSnapshots("object:a")[0]?.ownedByteLength).toBe(0);
    release();
    publisher.dispose();
  });

  it("publishes a late adoption only after a subsequent committed render frame", async () => {
    const controller = new VisualizationDebugController();
    const registry = createViewport3DRenderAdoptionRegistry();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: registry,
      buildCandidate: async ({ targetId }) => ({
        materialize: ({ frame, receipts }) => ({
          ...snapshot(targetId, frame.commitId),
          ownedByteLength: receipts[0]?.itemCount ?? 0,
        }),
      }),
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("airbox");
    publisher.update({
      carrierTargets: new Map([["part:__air__", ["airbox"]]]),
      revision: "field-22",
      targetIds: ["airbox"],
    });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-latest" });
    expect(controller.getSnapshots("airbox")[0]?.ownedByteLength).toBe(0);

    registry.recordVectorAdoption({
      byteLength: 291_256,
      carrierId: "part:__air__",
      fieldBufferId: "field-22",
      itemCount: 10_604,
      resourceKey: "resource-22",
      vectorBuildKey: "vector-22",
    });
    await Promise.resolve();

    expect(controller.getSnapshots("airbox")[0]).toMatchObject({
      ownedByteLength: 0,
      viewport: { frameCommitId: "frame-latest" },
    });

    publisher.commitFrame({ commitId: "frame-with-adoption" });
    expect(controller.getSnapshots("airbox")[0]).toMatchObject({
      ownedByteLength: 10_604,
      viewport: { frameCommitId: "frame-with-adoption" },
    });
    release();
    publisher.dispose();
  });

  it("coalesces late adoption changes for one target without republishing another target", async () => {
    const controller = new VisualizationDebugController();
    const registry = createViewport3DRenderAdoptionRegistry();
    const materializeByTarget = new Map<string, ReturnType<typeof vi.fn>>();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: registry,
      buildCandidate: async ({ targetId }) => {
        const materialize = vi.fn(({ frame, receipts }) => ({
          ...snapshot(targetId, frame.commitId),
          ownedByteLength: receipts.length,
        }));
        materializeByTarget.set(targetId, materialize);
        return { materialize };
      },
      controller,
      viewportId: "viewport-main",
    });
    const releaseA = controller.request("object:a");
    const releaseB = controller.request("object:b");
    publisher.update({
      carrierTargets: new Map([
        ["part:a", ["object:a"]],
        ["part:b", ["object:b"]],
      ]),
      revision: "field-1",
      targetIds: ["object:a", "object:b"],
    });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-retained" });
    materializeByTarget.get("object:a")?.mockClear();
    materializeByTarget.get("object:b")?.mockClear();

    registry.recordSurfaceAdoption({
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      scalarBufferKey: "scalar-a",
    });
    registry.recordVectorAdoption({
      byteLength: 48,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      vectorBuildKey: "vector-a",
    });
    await Promise.resolve();

    expect(materializeByTarget.get("object:a")).not.toHaveBeenCalled();
    expect(materializeByTarget.get("object:b")).not.toHaveBeenCalled();
    publisher.commitFrame({ commitId: "frame-with-adoption" });
    expect(materializeByTarget.get("object:a")).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshots("object:a")[0]).toMatchObject({
      ownedByteLength: 2,
      viewport: { frameCommitId: "frame-with-adoption" },
    });

    registry.recordSurfaceAdoption({
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      scalarBufferKey: "scalar-a",
    });
    registry.recordVectorAdoption({
      byteLength: 48,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      vectorBuildKey: "vector-a",
    });
    await Promise.resolve();
    expect(materializeByTarget.get("object:a")).toHaveBeenCalledTimes(1);

    releaseA();
    releaseB();
    publisher.dispose();
  });

  it("publishes exact pending receipts when an invalidated frame commits with the retained revision id", async () => {
    const controller = new VisualizationDebugController();
    const registry = createViewport3DRenderAdoptionRegistry();
    const materializeByTarget = new Map<string, ReturnType<typeof vi.fn>>();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: registry,
      buildCandidate: async ({ targetId }) => {
        const materialize = vi.fn(({ frame, receipts }) => ({
          ...snapshot(targetId, frame.commitId),
          ownedByteLength: receipts.length,
        }));
        materializeByTarget.set(targetId, materialize);
        return { materialize };
      },
      controller,
      viewportId: "viewport-main",
    });
    const releaseA = controller.request("object:a");
    const releaseB = controller.request("object:b");
    publisher.update({
      carrierTargets: new Map([
        ["part:a", ["object:a"]],
        ["part:b", ["object:b"]],
      ]),
      revision: "field-1",
      targetIds: ["object:a", "object:b"],
    });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-retained" });
    materializeByTarget.get("object:a")?.mockClear();
    materializeByTarget.get("object:b")?.mockClear();

    registry.recordSurfaceAdoption({
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      resourceKey: "resource-a",
      scalarBufferKey: "scalar-a",
    });
    registry.recordVectorAdoption({
      byteLength: 48,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      resourceKey: "resource-a",
      vectorBuildKey: "vector-a",
    });
    const sequencesBeforeCommit = registry
      .snapshot("object:a")
      .map((receipt) => receipt.adoptionSequence);
    publisher.commitFrame({ commitId: "frame-retained" });
    await Promise.resolve();

    expect(materializeByTarget.get("object:a")).toHaveBeenCalledTimes(1);
    expect(materializeByTarget.get("object:b")).not.toHaveBeenCalled();
    expect(controller.getSnapshots("object:a")[0]).toMatchObject({
      ownedByteLength: 2,
      viewport: { frameCommitId: "frame-retained" },
    });
    expect(
      registry
        .snapshot("object:a")
        .map((receipt) => receipt.adoptionSequence),
    ).toEqual(sequencesBeforeCommit);

    releaseA();
    releaseB();
    publisher.dispose();
  });

  it("invalidates a pending coalesced adoption publication on dispose", async () => {
    const controller = new VisualizationDebugController();
    const registry = createViewport3DRenderAdoptionRegistry();
    const materialize = vi.fn(({ frame, receipts }) => ({
      ...snapshot("object:a", frame.commitId),
      ownedByteLength: receipts.length,
    }));
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: registry,
      buildCandidate: async () => ({ materialize }),
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("object:a");
    publisher.update({
      carrierTargets: new Map([["part:a", ["object:a"]]]),
      revision: "field-1",
      targetIds: ["object:a"],
    });
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-retained" });
    materialize.mockClear();

    registry.recordSurfaceAdoption({
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      scalarBufferKey: "scalar-a",
    });
    publisher.dispose();
    await Promise.resolve();

    expect(materialize).not.toHaveBeenCalled();
    expect(controller.getSnapshots("object:a")).toEqual([]);
    release();
  });

  it("publishes one scanning snapshot before one complete snapshot on the first committed frame", async () => {
    let resolveScan!: (value: VisualizationDebugNumericStats) => void;
    const scanStatistics = vi.fn(
      () =>
        new Promise<VisualizationDebugNumericStats>((resolve) => {
          resolveScan = resolve;
        }),
    );
    const recordScan = vi.fn();
    const controller = new VisualizationDebugController();
    const buildCandidate = createViewport3DVisualizationDebugCandidateBuilder({
      recordScan,
      scanStatistics,
      source: syntheticScanSource(),
      viewportId: "viewport-main",
    });
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate,
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("airbox");
    publisher.update({ revision: "field-1", targetIds: ["airbox"] });
    await Promise.resolve();
    await Promise.resolve();

    expect(scanStatistics).not.toHaveBeenCalled();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe("airbox", listener);
    publisher.commitFrame({ commitId: "frame-1", committedAtMs: 10 });

    expect(recordScan).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshots("airbox")[0]?.carriers[0]?.scanState).toBe(
      "scanning",
    );

    resolveScan({
      finiteCount: 6,
      max: 6,
      mean: 3.5,
      min: 1,
      nonFiniteCount: 0,
      p01: null,
      p99: null,
      source: "decoded-payload",
      zeroCount: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getSnapshots("airbox")[0]?.carriers[0]?.scanState).toBe(
      "complete",
    );
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    release();
    publisher.dispose();
  });

  it("aborts an active scan on revision change without publishing stale completion", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: VisualizationDebugNumericStats) => void> = [];
    const scanStatistics = vi.fn(
      (
        _values: Float64Array,
        options?: { signal?: AbortSignal; yieldToMain?: () => Promise<void> },
      ) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise<VisualizationDebugNumericStats>((resolve) => {
          resolvers.push(resolve);
        });
      },
    );
    const controller = new VisualizationDebugController();
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: createViewport3DVisualizationDebugCandidateBuilder({
        scanStatistics,
        source: syntheticScanSource(),
        viewportId: "viewport-main",
      }),
      controller,
      viewportId: "viewport-main",
    });
    const release = controller.request("airbox");
    publisher.update({ revision: "field-1", targetIds: ["airbox"] });
    await Promise.resolve();
    await Promise.resolve();
    publisher.commitFrame({ commitId: "frame-1", committedAtMs: 1 });
    expect(controller.getSnapshots("airbox")[0]?.carriers[0]?.scanState).toBe(
      "scanning",
    );

    publisher.update({ revision: "field-2", targetIds: ["airbox"] });
    expect(signals[0]?.aborted).toBe(true);
    expect(controller.getSnapshots("airbox")).toEqual([]);
    resolvers[0]?.({
      finiteCount: 6,
      max: 6,
      mean: 3.5,
      min: 1,
      nonFiniteCount: 0,
      p01: null,
      p99: null,
      source: "decoded-payload",
      zeroCount: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshots("airbox")).toEqual([]);

    release();
    publisher.dispose();
  });
});

describe("groupViewport3DVisualizationDebugCarriers", () => {
  it("groups multi-carrier objects and Airbox by canonical catalog mapping", () => {
    const grouped = groupViewport3DVisualizationDebugCarriers({
      carrierIds: ["part:a", "part:b", "part:__air__"],
      targetByCarrierId: new Map([
        ["part:a", "object:sample"],
        ["part:b", "object:sample"],
        ["part:__air__", "airbox"],
      ]),
    });

    expect(grouped.get("object:sample")).toEqual(["part:a", "part:b"]);
    expect(grouped.get("airbox")).toEqual(["part:__air__"]);
  });

  it("keeps the explicit FDM derived-global carrier attached to its logical target", () => {
    const grouped = groupViewport3DVisualizationDebugCarriers({
      carrierIds: ["fdm-domain"],
      derivedGlobalTargetIds: ["object:sample"],
      targetByCarrierId: new Map(),
    });

    expect(grouped.get("object:sample")).toEqual(["fdm-domain"]);
  });
});

describe("FDM exact target carrier resolution", () => {
  it("materializes the exact FDM render carrier without a FEM field model", async () => {
    const base = syntheticScanSource({ exactRange: true });
    const pass = base.fieldModel!.targetPasses.get("part:__air__")!;
    const targetId = "object:sample";
    const source = {
      ...base,
      fieldModel: null,
      fullFieldBufferIdentity: {
        bufferId: "field-fdm",
        currentDomainGenerationId: "fdm-generation",
        resourceKey: "/v2/sessions/current/data/fields/H_demag/samples/vector?component=full&scope_kind=full",
      },
      fullFieldVector: {
        domainGenerationId: "fdm-generation",
        dtype: "float64" as const,
        formatVersion: 3 as const,
        grid: [2, 1, 1] as [number, number, number],
        indexing: "dense_grid" as const,
        meshTopologyHash: null,
        meshTopologyRevision: null,
        nComp: 3,
        nodeIndices: null,
        pointCount: 2,
        quantityId: "H_demag",
        scopeId: null,
        scopeKind: "full" as const,
        valueCount: 6,
        values: new Float64Array([1, 2, 3, 4, 5, 6]),
      },
      targets: [
        {
          carrierIds: [targetId],
          renderPass: { ...pass, fieldBuffer: null },
          target: { id: targetId, kind: "object" as const, label: "Sample" },
        },
      ],
    } as unknown as Viewport3DVisualizationDebugSource;
    const candidate = await createViewport3DVisualizationDebugCandidateBuilder({
      source,
      viewportId: "viewport-main",
    })({ signal: new AbortController().signal, targetId });

    const snapshot = candidate.materialize({
      frame: { commitId: "frame-fdm-exact", committedAtMs: 1 },
      receipts: [],
    });

    expect(snapshot.target.carrierIds).toEqual([targetId]);
    expect(snapshot.carriers[0]).toMatchObject({
      carrierId: targetId,
      request: { resourceKey: source.fullFieldBufferIdentity!.resourceKey },
    });
  });
});

describe("createViewport3DVisualizationDebugCandidateBuilder", () => {
  it("publishes cancelled once when an actual scan is aborted", async () => {
    let resolveScan!: (value: VisualizationDebugNumericStats) => void;
    const abortController = new AbortController();
    const candidate = await createViewport3DVisualizationDebugCandidateBuilder({
      scanStatistics: () =>
        new Promise<VisualizationDebugNumericStats>((resolve) => {
          resolveScan = resolve;
        }),
      source: syntheticScanSource(),
      viewportId: "viewport-main",
    })({ signal: abortController.signal, targetId: "airbox" });
    const listener = vi.fn();
    const unsubscribe = candidate.subscribe?.(listener) ?? (() => undefined);
    candidate.start?.();

    abortController.abort();
    expect(candidate.materialize({
      frame: { commitId: "frame-cancelled", committedAtMs: 1 },
      receipts: [],
    }).carriers[0]?.scanState).toBe("cancelled");
    expect(listener).toHaveBeenCalledTimes(1);

    resolveScan({
      finiteCount: 6,
      max: 6,
      mean: 3.5,
      min: 1,
      nonFiniteCount: 0,
      p01: null,
      p99: null,
      source: "decoded-payload",
      zeroCount: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("reuses exact render range diagnostics without starting a full scan or probe", async () => {
    const recordScan = vi.fn();
    const scanStatistics = vi.fn();
    const builder = createViewport3DVisualizationDebugCandidateBuilder({
      recordScan,
      scanStatistics,
      source: syntheticScanSource({ exactRange: true }),
      viewportId: "viewport-main",
    });
    const candidate = await builder({
      signal: new AbortController().signal,
      targetId: "airbox",
    });

    candidate.start?.();
    const result = candidate.materialize({
      frame: { commitId: "frame-range", committedAtMs: 1 },
      receipts: [],
    });

    expect(recordScan).not.toHaveBeenCalled();
    expect(scanStatistics).not.toHaveBeenCalled();
    expect(result.carriers[0]?.scanState).toBe("complete");
    expect(result.carriers[0]?.statistics).toContainEqual(
      expect.objectContaining({ source: "render-derived", min: 1, max: 4 }),
    );
  });

  it("uses the receipt scalar key for synchronous colors without a derived build key", async () => {
    const source = syntheticScanSource({ exactRange: true });
    const pass = source.fieldModel!.targetPasses.get("part:__air__")!;
    const scalarColors = pass.surface.scalarColors!;
    delete scalarColors.buildKey;
    const candidate = await createViewport3DVisualizationDebugCandidateBuilder({
      source,
      viewportId: "viewport-main",
    })({ signal: new AbortController().signal, targetId: "airbox" });
    await settleCandidate(candidate);

    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["part:__air__", ["airbox"]]]));
    registry.retainDemand("airbox");
    recordMeshPartSurfaceAdoption({
      carrierId: "part:__air__",
      fieldBufferId: pass.fieldBuffer?.bufferId ?? null,
      registry,
      scalarBuffer: scalarColors,
    });
    const receipts = registry.snapshot("airbox");
    const result = candidate.materialize({
      frame: { commitId: "frame-sync-scalar", committedAtMs: 1 },
      receipts,
    });

    expect(receipts[0]?.scalarBufferKey).toBe(
      resolveViewport3DScalarColorBufferKey(scalarColors),
    );
    expect(result.carriers[0]?.render.surface.bufferKey).toBe(
      receipts[0]?.scalarBufferKey,
    );
    expect(result.issues.map((issue) => issue.code)).not.toContain(
      "adopted-source-mismatch",
    );
  });

  it("uses the same exact fallback scalar identity for FDM adoption and debug evidence", async () => {
    const source = syntheticScanSource({ exactRange: true });
    const pass = source.fieldModel!.targetPasses.get("part:__air__")!;
    const scalarColors = pass.surface.scalarColors!;
    delete scalarColors.buildKey;
    const fdmSource: Viewport3DVisualizationDebugSource = {
      ...source,
      carrierRoles: new Map([["fdm-domain", "fdm-domain"]]),
      fieldModel: {
        ...source.fieldModel!,
        targetPasses: new Map([
          [
            "full",
            {
              ...pass,
              fieldBuffer: null,
              fieldBufferState: "derived-global" as const,
            },
          ],
        ]),
      },
      fullFieldBufferIdentity: {
        bufferId: "field-fdm",
        currentDomainGenerationId: null,
        resourceKey: null,
      },
      fullFieldVector: {
        dtype: "float64",
        grid: [2, 1, 1],
        nComp: 3,
        pointCount: 2,
        quantityId: "synthetic-airbox",
        valueCount: 6,
        values: new Float64Array([1, 2, 3, 4, 5, 6]),
      },
      targets: [
        {
          carrierIds: [],
          target: { id: "object:sample", kind: "object", label: "Sample" },
        },
      ],
    };
    const candidate = await createViewport3DVisualizationDebugCandidateBuilder({
      source: fdmSource,
      viewportId: "viewport-main",
    })({ signal: new AbortController().signal, targetId: "object:sample" });
    await settleCandidate(candidate);
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["fdm-domain", ["object:sample"]]]));
    registry.retainDemand("object:sample");
    recordFdmCuboidSurfaceAdoption({
      fieldBufferId: "field-fdm",
      registry,
      scalarBuffer: scalarColors,
    });
    const receipts = registry.snapshot("object:sample");
    const result = candidate.materialize({
      frame: { commitId: "frame-fdm-scalar", committedAtMs: 1 },
      receipts,
    });

    expect(receipts[0]?.scalarBufferKey).toBe(
      resolveViewport3DScalarColorBufferKey(scalarColors),
    );
    expect(result.carriers[0]?.render.surface.bufferKey).toBe(
      receipts[0]?.scalarBufferKey,
    );
    expect(result.issues.map((issue) => issue.code)).not.toContain(
      "adopted-source-mismatch",
    );
  });

  it("binds outside-support FDM fallback evidence to its exact render carrier", async () => {
    const source = syntheticScanSource({ exactRange: true });
    const pass = source.fieldModel!.targetPasses.get("part:__air__")!;
    const scalarColors = pass.surface.scalarColors!;
    const targetId = "fdm-universe-outside-support";
    const fdmSource: Viewport3DVisualizationDebugSource = {
      ...source,
      carrierRoles: new Map([[targetId, "fdm-domain"]]),
      fieldModel: {
        ...source.fieldModel!,
        targetPasses: new Map([
          [
            "full",
            {
              ...pass,
              fieldBuffer: null,
              fieldBufferState: "derived-global" as const,
            },
          ],
        ]),
      },
      fullFieldBufferIdentity: {
        bufferId: "field-fdm-airbox",
        currentDomainGenerationId: null,
        resourceKey: null,
      },
      fullFieldVector: {
        dtype: "float64",
        grid: [2, 1, 1],
        nComp: 3,
        pointCount: 2,
        quantityId: "H_demag",
        valueCount: 6,
        values: new Float64Array([1, 2, 3, 4, 5, 6]),
      },
      targets: [
        {
          carrierIds: [targetId],
          target: { id: targetId, kind: "fdm-domain", label: "Airbox" },
        },
      ],
    };
    const candidate = await createViewport3DVisualizationDebugCandidateBuilder({
      source: fdmSource,
      viewportId: "viewport-main",
    })({ signal: new AbortController().signal, targetId });
    await settleCandidate(candidate);
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([[targetId, [targetId]]]));
    registry.retainDemand(targetId);
    recordFdmCuboidSurfaceAdoption({
      carrierId: targetId,
      fieldBufferId: "field-fdm-airbox",
      registry,
      scalarBuffer: scalarColors,
    });

    const result = candidate.materialize({
      frame: { commitId: "frame-fdm-airbox", committedAtMs: 1 },
      receipts: registry.snapshot(targetId),
    });

    expect(result.target.carrierIds).toEqual([targetId]);
    expect(result.carriers[0]?.carrierId).toBe(targetId);
    expect(result.carriers[0]?.render.adoption.surface).toMatchObject({
      adoptedFieldBufferId: "field-fdm-airbox",
      adoptedScalarBufferKey:
        resolveViewport3DScalarColorBufferKey(scalarColors),
    });
    expect(result.issues.map((issue) => issue.code)).not.toContain(
      "adopted-source-mismatch",
    );
  });

  it.each([
    ["c0", false],
    ["full", true],
  ] as const)(
    "treats range component %s against rendered x with semantic exactness",
    async (rangeComponent, shouldScan) => {
      const source = syntheticScanSource({ exactRange: true });
      const pass = source.fieldModel!.targetPasses.get("part:__air__")!;
      pass.surface.scalarColors = {
        ...pass.surface.scalarColors!,
        colorMode: rangeComponent,
      };
      const recordScan = vi.fn();
      const scanStatistics = vi.fn(async () => ({
        finiteCount: 6,
        max: 6,
        mean: 3.5,
        min: 1,
        nonFiniteCount: 0,
        p01: null,
        p99: null,
        source: "render-derived" as const,
        zeroCount: 0,
      }));
      const candidate = await createViewport3DVisualizationDebugCandidateBuilder({
        recordScan,
        scanStatistics,
        source,
        viewportId: "viewport-main",
      })({ signal: new AbortController().signal, targetId: "airbox" });

      candidate.start?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(recordScan).toHaveBeenCalledTimes(shouldScan ? 1 : 0);
      expect(scanStatistics).toHaveBeenCalledTimes(shouldScan ? 1 : 0);
    },
  );

  it("labels scanned synthetic render values as render-derived without decoded payload evidence", async () => {
    const values = new Float64Array([1, 2, 3, 4, 5, 6]);
    const fieldBuffer = {
      bufferId: "synthetic:airbox:vectors",
      capability: "synthetic-full-vector" as const,
      component: "full" as const,
      componentCount: 3,
      consumers: [],
      decodedFieldVector: null,
      domainGenerationId: null,
      fieldRevision: null,
      indexing: "legacy_count_only" as const,
      meshTopologyHash: null,
      nodeIndexCount: null,
      nodeIndices: null,
      pointCount: 2,
      quantityId: "synthetic-airbox",
      requestId: null,
      resourceKey: null,
      sampled: false,
      scopeId: "part:__air__",
      scopeKind: "airbox" as const,
      topologyRevision: null,
      values,
      vectorComponentCount: 3,
    };
    const builder = createViewport3DVisualizationDebugCandidateBuilder({
      source: {
        carrierRoles: new Map([["part:__air__", "air"]]),
        fieldModel: {
          complexFieldVector: null,
          derivedWorkItems: [],
          fullVectorBuild: null,
          fullVectorSegments: null,
          partVectorBuilds: new Map(),
          partVectorSegments: new Map(),
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map(),
          targetDiagnostics: [],
          targetPasses: new Map([
            [
              "part:__air__",
              {
                fieldBuffer,
                fieldBufferState: "target-buffer" as const,
                surface: {
                  degradation: null,
                  passId: "part:__air__:surface",
                  scalarColorMode: null,
                  scalarColors: null,
                },
                vectors: {
                  buildReference: null,
                  degradation: "vector-segments-unavailable",
                  passId: "part:__air__:vector-glyph",
                  segments: null,
                },
              },
            ],
          ]),
          visualizationPhaseRad: null,
        },
        fullFieldVector: null,
        targets: [
          {
            carrierIds: ["part:__air__"],
            target: { id: "airbox", kind: "airbox", label: "Airbox" },
          },
        ],
        topologyByteLength: null,
        visualizationRevision: "viz-1",
        webglSharedByteLength: null,
      },
      viewportId: "viewport-main",
    });

    const candidate = await builder({
      signal: new AbortController().signal,
      targetId: "airbox",
    });
    await settleCandidate(candidate);
    const result = candidate.materialize({
      frame: { commitId: "frame-synthetic", committedAtMs: 7 },
      receipts: [],
    });

    expect(result.carriers[0]?.payload).toBeNull();
    expect(result.carriers[0]?.carrierRole).toBe("air");
    expect(result.carriers[0]?.samples).toEqual([]);
    expect(result.carriers[0]?.statistics).toEqual([
      expect.objectContaining({
        max: 6,
        min: 1,
        source: "render-derived",
      }),
    ]);
    expect(result.carriers[0]?.statistics).not.toContainEqual(
      expect.objectContaining({ source: "decoded-payload" }),
    );
    expect(result.carriers[0]?.render.requestedPasses).toContain("vector-glyph");
    expect(result.carriers[0]?.render.vectors.degradation).toBe(
      "vector-segments-unavailable",
    );
    expect(result.carriers[0]?.memory).toContainEqual(
      expect.objectContaining({ id: "wire", byteLength: null }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "vector-pass-missing" }),
    );
  });

  it("uses canonical request and current-domain truth independently from decoded payload", async () => {
    const decodedFieldVector: DecodedFieldVector = {
      domainGenerationId: "decoded-domain",
      dtype: "float64",
      formatVersion: 3,
      grid: [1, 1, 1],
      indexing: "full_domain",
      meshTopologyHash: "decoded-topology",
      meshTopologyRevision: "decoded-topology-revision",
      nComp: 3,
      nodeIndices: null,
      pointCount: 1,
      quantityId: "m",
      scopeId: null,
      scopeKind: "full",
      valueCount: 3,
      values: new Float64Array([1, 0, 0]),
    };
    const resourceKey = serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery("H_eff", {
        component: "x",
        scope_kind: "full",
      }),
    );
    const built = buildViewport3DTargetFieldBuffer({
      domain: {
        domainGenerationId: "current-domain",
        meshTopologyHash: "current-topology",
        meshTopologyRevision: "current-topology-revision",
        pointCount: 1,
      },
      fieldVector: decodedFieldVector,
      query: { component: "x", scope_kind: "full" },
      resourceKey,
      targetIds: ["part:a"],
    });
    const fieldBuffer = {
      bufferId: built.bufferId,
      capability: built.capability,
      component: built.component,
      componentCount: built.componentCount,
      consumers: built.consumers,
      currentDomainGenerationId: built.currentDomainGenerationId,
      currentMeshTopologyHash: built.currentMeshTopologyHash,
      decodedFieldVector: built.fieldVector,
      domainGenerationId: built.domainGenerationId,
      fieldRevision: built.fieldRevision,
      indexing: built.indexing,
      meshTopologyHash: built.meshTopologyHash,
      nodeIndexCount: built.nodeIndices?.length ?? null,
      nodeIndices: built.nodeIndices,
      pointCount: built.pointCount,
      quantityId: built.quantityId,
      requestId: built.requestId,
      resourceKey: built.resourceKey,
      sampled: built.sampled,
      scopeId: built.scopeId,
      scopeKind: built.scopeKind,
      topologyRevision: built.topologyRevision,
      values: built.values,
      vectorComponentCount: built.vectorComponentCount,
    };
    const builder = createViewport3DVisualizationDebugCandidateBuilder({
      source: {
        fieldModel: {
          complexFieldVector: null,
          derivedWorkItems: [],
          fullVectorBuild: null,
          fullVectorSegments: null,
          partVectorBuilds: new Map(),
          partVectorSegments: new Map(),
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map(),
          targetDiagnostics: [],
          targetPasses: new Map([
            [
              "part:a",
              {
                fieldBuffer,
                fieldBufferState: "target-buffer" as const,
                surface: {
                  degradation: "surface-colors-unavailable" as const,
                  passId: "part:a:surface",
                  scalarColorMode: "x",
                  scalarColors: null,
                },
                vectors: {
                  buildReference: null,
                  degradation: null,
                  passId: "part:a:vector-glyph",
                  segments: null,
                },
              },
            ],
          ]),
          visualizationPhaseRad: null,
        },
        fullFieldVector: null,
        targets: [
          {
            carrierIds: ["part:a"],
            target: { id: "object:a", kind: "object", label: "A" },
          },
        ],
        topologyByteLength: null,
        visualizationRevision: "viz-1",
        webglSharedByteLength: null,
      },
      viewportId: "viewport-main",
    });

    const candidate = await builder({
      signal: new AbortController().signal,
      targetId: "object:a",
    });
    await settleCandidate(candidate);
    const result = candidate.materialize({
      frame: { commitId: "frame-1", committedAtMs: 1 },
      receipts: [],
    });

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "quantity-mismatch" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "domain-generation-mismatch" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "topology-hash-mismatch" }),
    );
    expect(result.carriers[0]?.render.surface.colorMode).toBe("x");
  });

  it("preserves per-pass adoption proof when materializing multi-carrier snapshots", async () => {
    const field = (id: string) => {
      const values = new Float64Array([1, 0, 0]);
      const decodedFieldVector: DecodedFieldVector = {
        domainGenerationId: "domain-1",
        dtype: "float64",
        formatVersion: 3,
        grid: [1, 1, 1],
        indexing: "legacy_count_only",
        meshTopologyHash: "topology-hash-1",
        meshTopologyRevision: "mesh-1",
        nComp: 3,
        nodeIndices: null,
        pointCount: 1,
        quantityId: "m",
        scopeId: id,
        scopeKind: "part",
        valueCount: 3,
        values,
      };
      return {
        bufferId: `field-${id}`,
        capability: "full-vector-complete" as const,
        component: "full" as const,
        componentCount: 3,
        consumers: [],
        decodedFieldVector,
        domainGenerationId: "domain-1",
        fieldRevision: "field-1",
        indexing: "legacy_count_only" as const,
        meshTopologyHash: "topology-hash-1",
        nodeIndexCount: null,
        nodeIndices: null,
        pointCount: 1,
        quantityId: "m",
        requestId: `request-${id}`,
        resourceKey: `resource-${id}`,
        sampled: false,
        scopeId: id,
        scopeKind: "part" as const,
        topologyRevision: "mesh-1",
        values,
        vectorComponentCount: 3,
      };
    };
    const pass = (id: string) => ({
      fieldBuffer: field(id),
      fieldBufferState: "target-buffer" as const,
      surface: {
        degradation: null,
        passId: `${id}:surface`,
        scalarColorMode: "x",
        scalarColors: {
          buildKey: `scalar-${id}`,
          colors: new Float32Array([1, 0, 0]),
          colorMode: "x",
          range: { max: 1, min: 1 },
          rangeDiagnostics: {
            finiteCount: 1,
            max: 1,
            mean: 1,
            min: 1,
            nonFiniteCount: 0,
            outlierDominated: false,
            p01: 1,
            p99: 1,
            zeroCount: 0,
          },
        },
      },
      vectors: {
        buildReference: {
          buildKey: `vector-${id}`,
          fieldRevision: "field-1",
          groupKey: `vector-group-${id}`,
          revisionSummary: "topology=mesh-1 field=field-1",
          targetRevision: "field=field-1",
          topologyRevision: "mesh-1",
        },
        degradation: null,
        passId: `${id}:vector-glyph`,
        segments: new Float32Array([0, 0, 0, 1, 0, 0, 0]),
      },
    });
    const fieldModel = {
      complexFieldVector: null,
      derivedWorkItems: [],
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map(),
      scalarColors: null,
      scalarColorsByMode: new Map(),
      scalarColorsByPartAndMode: new Map(),
      targetDiagnostics: [],
      targetPasses: new Map([
        ["part:a", pass("part:a")],
        ["part:b", pass("part:b")],
      ]),
      visualizationPhaseRad: null,
    };
    const builder = createViewport3DVisualizationDebugCandidateBuilder({
      source: {
        fieldModel,
        fullFieldVector: null,
        targets: [{ carrierIds: ["part:a", "part:b"], target: { id: "object:a", kind: "object", label: "A" } }],
        topologyByteLength: 120,
        visualizationRevision: "viz-1",
        webglSharedByteLength: null,
      },
      viewportId: "viewport-main",
    });
    const candidate = await builder({ signal: new AbortController().signal, targetId: "object:a" });
    await settleCandidate(candidate);
    const result = candidate.materialize({
      frame: { commitId: "frame-1", committedAtMs: 1 },
      receipts: [{
        adoptedAtMs: 1_000,
        adoptionSequence: 1,
        byteLength: 12,
        carrierId: "part:a",
        fieldBufferId: "field-part:a",
        kind: "surface",
        resourceKey: "resource-part:a",
        scalarBufferKey: "scalar-part:a",
        targetId: "object:a",
        vectorBuildKey: null,
      }, {
        adoptedAtMs: 2_000,
        adoptionSequence: 2,
        byteLength: 28,
        carrierId: "part:a",
        fieldBufferId: "field-vector-old",
        itemCount: 1,
        kind: "vector",
        resourceKey: "resource-vector-old",
        scalarBufferKey: null,
        targetId: "object:a",
        vectorBuildKey: "vector-part:a",
      }],
    });

    expect(result.carriers.map((carrier) => carrier.carrierId)).toEqual(["part:a", "part:b"]);
    expect(result.carriers[0]?.render.adoption).toMatchObject({
      surface: {
        adoptedAtMs: 1_000,
        adoptedFieldBufferId: "field-part:a",
        adoptedResourceKey: "resource-part:a",
        adoptedScalarBufferKey: "scalar-part:a",
        adoptionSequence: 1,
      },
      vector: {
        adoptedAtMs: 2_000,
        adoptedFieldBufferId: "field-vector-old",
        adoptedResourceKey: "resource-vector-old",
        adoptedVectorBuildKey: "vector-part:a",
        adoptionSequence: 2,
      },
    });
    expect(result.carriers[0]?.render).toMatchObject({
      requestedFieldBufferId: "field-part:a",
      surface: { bufferKey: "scalar-part:a" },
    });
    expect(result.carriers[0]?.request.resourceKey).toBe("resource-part:a");
    expect(result.carriers[0]?.payload).toMatchObject({
      scopeId: "part:a",
      scopeKind: "part",
    });
    expect(result.carriers[0]?.revisions).toMatchObject({
      domainGenerationId: "domain-1",
      meshTopologyHash: "topology-hash-1",
      topologyRevision: "mesh-1",
    });
    expect(result.carriers[0]?.render.surface.colorMode).toBe("x");
    expect(result.carriers[0]?.statistics).toContainEqual(
      expect.objectContaining({ max: 1, min: 1, source: "render-derived" }),
    );
    expect(result.issues.map((issue) => issue.code)).toContain("adopted-source-mismatch");
    expect(result.disposition).toBe("degraded");
    expect(result.carriers[1]?.render.adoption.surface.adoptedScalarBufferKey).toBeNull();
  });

  it("reports exact FMVP v3 payload identity instead of normalized request identity", async () => {
    const values = new Float64Array([1, 2, 3]);
    const nodeIndices = new Uint32Array([7]);
    const decodedFieldVector: DecodedFieldVector = {
      domainGenerationId: "decoded-domain",
      dtype: "float64",
      formatVersion: 3,
      grid: [1, 1, 1],
      indexing: "explicit_node_indices",
      meshTopologyHash: "decoded-topology-hash",
      meshTopologyRevision: "decoded-topology-revision",
      nComp: 3,
      nodeIndices,
      pointCount: 1,
      quantityId: "H_demag",
      scopeId: "part:__air__",
      scopeKind: "airbox",
      valueCount: 3,
      values,
    };
    const fieldBuffer = {
      bufferId: "field-airbox",
      capability: "full-vector-complete" as const,
      component: "full" as const,
      componentCount: 3,
      consumers: [],
      decodedFieldVector,
      domainGenerationId: "request-domain",
      fieldRevision: "field-1",
      indexing: "legacy_count_only" as const,
      meshTopologyHash: "request-topology-hash",
      nodeIndexCount: null,
      nodeIndices: null,
      pointCount: 1,
      quantityId: "m",
      requestId: "request-airbox",
      resourceKey: "resource-airbox",
      sampled: false,
      scopeId: "query-part",
      scopeKind: "part" as const,
      topologyRevision: "request-topology-revision",
      values,
      vectorComponentCount: 3,
    };
    const pass = {
      fieldBuffer,
      fieldBufferState: "target-buffer" as const,
      surface: {
        degradation: null,
        passId: "part:__air__:surface",
        scalarColorMode: null,
        scalarColors: null,
      },
      vectors: {
        buildReference: null,
        degradation: null,
        passId: "part:__air__:vector-glyph",
        segments: new Float32Array([0, 0, 0, 1, 0, 0, 0]),
      },
    };
    const builder = createViewport3DVisualizationDebugCandidateBuilder({
      source: {
        fieldModel: {
          complexFieldVector: null,
          derivedWorkItems: [],
          fullVectorBuild: null,
          fullVectorSegments: null,
          partVectorBuilds: new Map(),
          partVectorSegments: new Map(),
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map(),
          targetDiagnostics: [],
          targetPasses: new Map([["part:__air__", pass]]),
          visualizationPhaseRad: null,
        },
        fullFieldVector: null,
        targets: [{
          carrierIds: ["part:__air__"],
          target: { id: "airbox", kind: "airbox", label: "Airbox" },
        }],
        topologyByteLength: null,
        visualizationRevision: "viz-1",
        webglSharedByteLength: null,
      },
      viewportId: "viewport-main",
    });

    const candidate = await builder({
      signal: new AbortController().signal,
      targetId: "airbox",
    });
    await settleCandidate(candidate);
    const result = candidate.materialize({
      frame: { commitId: "frame-airbox", committedAtMs: 5 },
      receipts: [],
    });

    expect(result.carriers[0]?.payload).toEqual({
      component: null,
      dtype: "float64",
      formatVersion: 3,
      grid: [1, 1, 1],
      indexing: "explicit_node_indices",
      nComp: 3,
      nodeIndexCount: 1,
      pointCount: 1,
      quantityId: "H_demag",
      scopeId: "part:__air__",
      scopeKind: "airbox",
      valueCount: 3,
    });
    expect(result.carriers[0]?.revisions).toMatchObject({
      domainGenerationId: "decoded-domain",
      meshTopologyHash: "decoded-topology-hash",
      topologyRevision: "decoded-topology-revision",
    });
  });

  it("keeps legacy FMVP v2 fallback payload identity unknown instead of fabricating v3 full scope", async () => {
    const values = new Float64Array([1, 0, 0]);
    const fullFieldVector: DecodedFieldVector = {
      domainGenerationId: null,
      dtype: "float64" as const,
      formatVersion: 2,
      grid: [1, 1, 1] as [number, number, number],
      indexing: "legacy_count_only",
      meshTopologyHash: null,
      meshTopologyRevision: null,
      nComp: 3,
      nodeIndices: null,
      pointCount: 1,
      quantityId: "m",
      scopeId: null,
      scopeKind: null,
      valueCount: 3,
      values,
    };
    const fullPass = {
      fieldBuffer: null,
      fieldBufferState: "derived-global" as const,
      surface: {
        degradation: null,
        passId: "full:surface",
        scalarColorMode: null,
        scalarColors: null,
      },
      vectors: {
        buildReference: null,
        degradation: null,
        passId: "full:vector-glyph",
        segments: new Float32Array([0, 0, 0, 1, 0, 0]),
      },
    };
    const builder = createViewport3DVisualizationDebugCandidateBuilder({
      source: {
        fieldModel: {
          complexFieldVector: null,
          derivedWorkItems: [],
          fullVectorBuild: null,
          fullVectorSegments: fullPass.vectors.segments,
          partVectorBuilds: new Map(),
          partVectorSegments: new Map(),
          scalarColors: null,
          scalarColorsByMode: new Map(),
          scalarColorsByPartAndMode: new Map(),
          targetDiagnostics: [],
          targetPasses: new Map([["full", fullPass]]),
          visualizationPhaseRad: null,
        },
        fullFieldBufferIdentity: {
          bufferId: "field-fdm",
          currentDomainGenerationId: "current-fdm-domain",
          resourceKey: "resource-fdm",
        },
        fullFieldVector,
        targets: [{
          carrierIds: [],
          target: { id: "object:sample", kind: "object", label: "Sample" },
        }],
        topologyByteLength: null,
        visualizationRevision: "viz-1",
        webglSharedByteLength: null,
      },
      viewportId: "viewport-main",
    });

    const candidate = await builder({
      signal: new AbortController().signal,
      targetId: "object:sample",
    });
    await settleCandidate(candidate);
    const result = candidate.materialize({
      frame: { commitId: "frame-fdm", committedAtMs: 4 },
      receipts: [],
    });

    expect(result.target.carrierIds).toEqual(["fdm-domain"]);
    expect(result.carriers[0]).toMatchObject({
      carrierId: "fdm-domain",
      carrierRole: "fdm-domain",
      geometryMaskDescription: "logical target geometry mask",
      payload: {
        formatVersion: 2,
        indexing: "legacy_count_only",
        scopeId: null,
        scopeKind: null,
      },
      request: { resourceKey: "resource-fdm" },
      render: { requestedFieldBufferId: "field-fdm" },
      revisions: {
        domainGenerationId: null,
        meshTopologyHash: null,
        topologyRevision: null,
      },
    });
    expect(result.disposition).toBe("unknown");
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "scope-kind-mismatch" }),
    );
  });
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
