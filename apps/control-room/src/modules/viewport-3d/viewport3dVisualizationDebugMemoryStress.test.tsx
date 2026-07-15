import { describe, expect, it, vi } from "vitest";

import {
  MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES,
  VisualizationDebugController,
} from "@/kernel/visualization/VisualizationDebugController";

import { createViewport3DRenderAdoptionRegistry } from "./model/viewport3DRenderAdoptionRegistry";
import { Viewport3DResourceTracker } from "./viewport3dDiagnostics";
import { createViewport3DVisualizationDebugPublisher } from "./hooks/useViewport3DVisualizationDebugPublisher";
import { buildFieldVectorDebugSamples } from "./model/scanFieldVectorDebugStatistics";
import { buildVisualizationDebugPanelModel } from "@/modules/inspector/panels/visualization-debug/VisualizationDebugPanelModel";
import { createVisualizationDebugEvidenceActions } from "@/modules/inspector/panels/visualization-debug/visualizationDebugExport";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";

describe("visualization debug lifecycle and memory stress", () => {
  it("reports zero closed and settled work, then releases all lifecycle state", async () => {
    const controller = new VisualizationDebugController();
    const tracker = new Viewport3DResourceTracker();
    let scanTasks = 0;
    let scanCount = 0;
    let publishCount = 0;
    const originalCommit = controller.commit.bind(controller);
    vi.spyOn(controller, "commit").mockImplementation((...args) => {
      publishCount += 1;
      originalCommit(...args);
    });
    const publisher = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
      buildCandidate: async ({ signal, targetId }) => {
        scanTasks += 1;
        scanCount += 1;
        await Promise.resolve();
        scanTasks -= 1;
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        return {
          materialize: ({ frame }) => ({
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
              frameCommittedAtMs: 1,
              frameCommitId: frame.commitId,
              viewportId: "viewport-main",
            },
          }),
        };
      },
      controller,
      viewportId: "viewport-main",
    });

    publisher.update({ revision: "closed", targetIds: ["object:0"] });
    publisher.commitFrame({ commitId: "closed" });
    await Promise.resolve();
    expect({ publishCount, scanCount, scanTasks }).toEqual({
      publishCount: 0,
      scanCount: 0,
      scanTasks: 0,
    });
    expect(controller.getLifecycleStats()).toEqual({
      activeDemandCount: 0,
      activePublisherCount: 1,
      demandedTargetCount: 0,
      retainedSnapshotCount: 0,
    });
    expect(publisher.getLifecycleStats()).toMatchObject({
      activeTargetCount: 0,
      pendingCandidateCount: 0,
    });

    for (let index = 0; index < 50; index += 1) {
      const targetId = `object:${index}`;
      const release = controller.request(targetId);
      publisher.update({ revision: `revision:${index}`, targetIds: [targetId] });
      await vi.waitFor(() => {
        expect(publisher.getLifecycleStats().pendingCandidateCount).toBe(0);
      });
      publisher.commitFrame({ commitId: `frame:${index}` });
      await vi.waitFor(() => {
        expect(
          controller.getSnapshots(targetId)[0]?.viewport.frameCommitId,
        ).toBe(`frame:${index}`);
      });
      const settled = { publishCount, scanCount };
      publisher.update({ revision: `revision:${index}`, targetIds: [targetId] });
      publisher.commitFrame({ commitId: `frame:${index}` });
      await Promise.resolve();
      expect({ publishCount, scanCount }).toEqual(settled);
      const encodedBytes = new TextEncoder().encode(
        JSON.stringify(controller.getSnapshots(targetId)),
      ).byteLength;
      expect(encodedBytes).toBeLessThanOrEqual(MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES);
      release();
    }

    const disposable = { dispose: vi.fn() };
    tracker.track("geometry", disposable, { byteLength: 1024 });
    expect(tracker.getLedgerSnapshot()).toHaveLength(1);
    tracker.disposeAll();
    publisher.dispose();

    expect(scanTasks).toBe(0);
    expect(controller.getLifecycleStats()).toEqual({
      activeDemandCount: 0,
      activePublisherCount: 0,
      demandedTargetCount: 0,
      retainedSnapshotCount: 0,
    });
    expect(publisher.getLifecycleStats()).toEqual({
      activeTargetCount: 0,
      disposed: true,
      pendingCandidateCount: 0,
      subscribedTargetCount: 0,
    });
    expect(tracker.getLedgerSnapshot()).toHaveLength(0);
    expect(tracker.getSnapshot()).toMatchObject({
      geometries: 0,
      materials: 0,
      renderTargets: 0,
      textures: 0,
      workers: 0,
    });
    expect(disposable.dispose).toHaveBeenCalledTimes(1);
  });

  it("unmounts the viewport while Inspector demand persists without retaining field or WebGL buffers", async () => {
    const controller = new VisualizationDebugController();
    const tracker = new Viewport3DResourceTracker();
    const values = new Float64Array(100 * 16);
    values.fill(1);
    const selection: SelectionRef = {
      kind: "object.visualization.debug",
      nodeId: "object:magnet:visualization:debug",
      objectId: "magnet",
      type: "scene-object",
      visualizationTargetId: "object:magnet",
    };
    const releaseInspectorDemand = controller.request("object:magnet");
    const viewport = mountViewportDebugConsumer({
      controller,
      targetId: "object:magnet",
      tracker,
      values,
    });
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    viewport.publisher.commitFrame({ commitId: "frame-mounted" });
    expect(controller.getSnapshots("object:magnet")).toHaveLength(1);
    expect(tracker.getLedgerSnapshot()).toHaveLength(2);

    viewport.unmount();

    expect(controller.getDemandSnapshot("object:magnet").expanded).toBe(true);
    expect(controller.getSnapshots("object:magnet")).toEqual([]);
    expect(values.byteLength).toBe(100 * 16 * Float64Array.BYTES_PER_ELEMENT);
    expect(tracker.getLedgerSnapshot()).toEqual([]);
    expect(tracker.getSnapshot()).toMatchObject({ geometries: 0, materials: 0 });
    const unavailable = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "viewport-3d",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection,
      snapshots: controller.getSnapshots("object:magnet"),
    });
    expect(unavailable.state).toBe("missing-snapshot");
    expect(unavailable.viewports).toEqual([]);
    const switchedCenterTab = buildVisualizationDebugPanelModel({
      activeViewportMainModuleId: "results",
      clientAcks: null,
      diagnostics: [],
      fieldMetaByQueryKey: new Map(),
      selection,
      snapshots: controller.getSnapshots("object:magnet"),
    });
    expect(switchedCenterTab.state).toBe("active-non-3d");
    expect(JSON.stringify(switchedCenterTab)).not.toContain("Float64Array");

    releaseInspectorDemand();
    expect(controller.getLifecycleStats()).toEqual({
      activeDemandCount: 0,
      activePublisherCount: 0,
      demandedTargetCount: 0,
      retainedSnapshotCount: 0,
    });
  });

  it("keeps sample, transport, object URL, and feedback timer budgets bounded across 50 panel cycles", () => {
    const values = new Float64Array(100 * 16);
    const samples = buildFieldVectorDebugSamples({
      nComp: 16,
      pointCount: 100,
      values,
    });
    expect(samples.samples).toHaveLength(12);
    expect(
      Math.max(...samples.samples.map((sample) => sample.componentValues.length)),
    ).toBe(8);

    let activeObjectUrls = 0;
    let activeTimers = 0;
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const actions = createVisualizationDebugEvidenceActions(
        {
          fieldQueries: [],
          state: "missing-snapshot",
          target: { id: `object:${cycle}`, kind: "object" },
          transport: Array.from({ length: 8 }, (_, index) => ({
            byteLength: index,
            channel: "http" as const,
            contentType: null,
            detail: null,
            direction: "rx" as const,
            durationMs: null,
            id: `request:${index}`,
            messageType: null,
            method: "GET",
            outcome: "ok" as const,
            path: "/field",
            requestId: `request:${index}`,
            resourceKey: `resource:${index}`,
            status: 200,
            timestampMs: index,
          })),
          viewports: [],
        },
        {
          clipboard: { writeText: async () => undefined },
          createObjectURL: () => {
            activeObjectUrls += 1;
            return `blob:debug:${cycle}`;
          },
          download: () => undefined,
          feedback: () => undefined,
          now: () => cycle,
          revokeObjectURL: () => {
            activeObjectUrls -= 1;
          },
          timers: {
            clear: () => {
              activeTimers -= 1;
            },
            set: () => {
              activeTimers += 1;
              return cycle;
            },
          },
        },
      );
      expect(JSON.parse(actions.rawJson()).model.transport).toHaveLength(8);
      actions.exportJson();
      actions.dispose();
      expect(activeObjectUrls).toBe(0);
      expect(activeTimers).toBe(0);
    }
  });
});

function mountViewportDebugConsumer({
  controller,
  targetId,
  tracker,
  values,
}: {
  controller: VisualizationDebugController;
  targetId: string;
  tracker: Viewport3DResourceTracker;
  values: Float64Array;
}) {
  tracker.track("geometry", { dispose: vi.fn() }, { byteLength: 1024 });
  tracker.track("material", { dispose: vi.fn() }, { byteLength: 256 });
  const publisher = createViewport3DVisualizationDebugPublisher({
    adoptionRegistry: createViewport3DRenderAdoptionRegistry(),
    buildCandidate: async ({ signal }) => {
      const samples = buildFieldVectorDebugSamples({
        nComp: 16,
        pointCount: 100,
        values,
      });
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      return {
        materialize: ({ frame }) => ({
          capturedAtMs: 1,
          carriers: [],
          disposition: "ready",
          issues: samples.issues,
          memoryTotals: { owned: 0, referenced: 0, shared: 1280 },
          ownedByteLength: 0,
          sharedMemory: [],
          target: { carrierIds: [], id: targetId, kind: "object", label: targetId },
          version: 1,
          viewport: {
            contextLost: false,
            drawingBuffer: [640, 480],
            frameCommittedAtMs: 1,
            frameCommitId: frame.commitId,
            viewportId: "viewport-main",
          },
        }),
      };
    },
    controller,
    viewportId: "viewport-main",
  });
  publisher.update({ revision: "mounted", targetIds: [targetId] });
  let mounted = true;
  return {
    publisher,
    unmount() {
      if (!mounted) return;
      mounted = false;
      publisher.dispose();
      tracker.disposeAll();
    },
  };
}
