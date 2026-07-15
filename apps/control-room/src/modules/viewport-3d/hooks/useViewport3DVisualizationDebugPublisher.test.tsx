import { describe, expect, it, vi } from "vitest";

import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { createViewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import {
  createViewport3DVisualizationDebugPublisher,
  createViewport3DVisualizationDebugCandidateBuilder,
  groupViewport3DVisualizationDebugCarriers,
  type Viewport3DVisualizationDebugCandidate,
  type Viewport3DVisualizationDebugFrameCommit,
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

  it("re-materializes the latest frame when a late adoption receipt arrives", async () => {
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
      ownedByteLength: 10_604,
      viewport: { frameCommitId: "frame-latest" },
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

    expect(materializeByTarget.get("object:a")).toHaveBeenCalledTimes(1);
    expect(materializeByTarget.get("object:b")).not.toHaveBeenCalled();
    expect(controller.getSnapshots("object:a")[0]).toMatchObject({
      ownedByteLength: 2,
      viewport: { frameCommitId: "frame-retained" },
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

  it("does not lose a pending adoption when the retained frame commits again with the same id", async () => {
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
    publisher.commitFrame({ commitId: "frame-retained" });
    await Promise.resolve();

    expect(materializeByTarget.get("object:a")).toHaveBeenCalledTimes(1);
    expect(materializeByTarget.get("object:b")).not.toHaveBeenCalled();
    expect(controller.getSnapshots("object:a")[0]).toMatchObject({
      ownedByteLength: 1,
      viewport: { frameCommitId: "frame-retained" },
    });

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

describe("createViewport3DVisualizationDebugCandidateBuilder", () => {
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
                  degradation: null,
                  passId: "part:__air__:vector-glyph",
                  segments: new Float32Array([0, 0, 0, 1, 0, 0, 0]),
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
    const result = candidate.materialize({
      frame: { commitId: "frame-synthetic", committedAtMs: 7 },
      receipts: [],
    });

    expect(result.carriers[0]?.payload).toBeNull();
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
  });

  it("materializes separate multi-carrier snapshots with actual adoption identities", async () => {
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
        buildReference: null,
        degradation: null,
        passId: `${id}:vector-glyph`,
        segments: null,
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
    const result = candidate.materialize({
      frame: { commitId: "frame-1", committedAtMs: 1 },
      receipts: [{
        byteLength: 12,
        carrierId: "part:a",
        fieldBufferId: "field-retained-old",
        kind: "surface",
        resourceKey: "resource-retained-old",
        scalarBufferKey: "scalar-adopted-a",
        targetId: "object:a",
        vectorBuildKey: null,
      }],
    });

    expect(result.carriers.map((carrier) => carrier.carrierId)).toEqual(["part:a", "part:b"]);
    expect(result.carriers[0]?.render.adoption).toMatchObject({
      adoptedFieldBufferId: "field-retained-old",
      adoptedResourceKey: "resource-retained-old",
      adoptedScalarBufferKey: "scalar-adopted-a",
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
    expect(result.carriers[1]?.render.adoption.adoptedScalarBufferKey).toBeNull();
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
