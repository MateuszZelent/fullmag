import { describe, expect, it, vi } from "vitest";

import {
  MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES,
  VisualizationDebugController,
} from "@/kernel/visualization/VisualizationDebugController";

import { createViewport3DRenderAdoptionRegistry } from "./model/viewport3DRenderAdoptionRegistry";
import { Viewport3DResourceTracker } from "./viewport3dDiagnostics";
import { createViewport3DVisualizationDebugPublisher } from "./hooks/useViewport3DVisualizationDebugPublisher";

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
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      expect(publisher.getLifecycleStats().pendingCandidateCount).toBe(0);
      publisher.commitFrame({ commitId: `frame:${index}` });
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
});
