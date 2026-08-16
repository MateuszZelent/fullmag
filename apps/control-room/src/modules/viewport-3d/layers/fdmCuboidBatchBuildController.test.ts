import { describe, expect, it } from "vitest";

import type { FdmCuboidBuildResult } from "./fdmCuboidBuildModel";
import {
  createFdmCuboidBatchBuildController,
  type FdmCuboidAsyncBuildEntry,
} from "./FdmCuboidLayer";

const EMPTY_RESULT: FdmCuboidBuildResult = {
  model: null,
  vectorCellIndices: null,
  vectorSegments: null,
};

function entry(id: string, buildKey: string): FdmCuboidAsyncBuildEntry {
  return {
    buildKey,
    cellSelection: "dense",
    domain: {
      bounds: null,
      displayCellBudget: 1,
      displayCellCount: 1,
      kind: "fdm-grid",
      origin: [0, 0, 0],
      shape: [1, 1, 1],
      spacing: [1, 1, 1],
      stride: 1,
      totalCells: 1,
    },
    enabled: true,
    groupKey: `group:${id}`,
    id,
    maxVectorGlyphs: 0,
    realizedRegionIds: null,
    revisionSummary: buildKey,
    vectorAnchorMode: "center",
    vectorScale: 1,
    voxelFillRatio: 0.92,
    voxelMagnitudeThreshold: 0,
    voxelTopography: {
      amplitudeCells: 0,
      component: "magnitude",
      enabled: false,
    },
  };
}

describe("FDM cuboid batch build controller", () => {
  it("does not publish a new snapshot when reconciling unchanged entries", () => {
    const controller = createFdmCuboidBatchBuildController(
      async () => EMPTY_RESULT,
    );
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });
    const entries = [entry("bottom", "bottom:r1")];

    controller.reconcile(entries);
    const firstSnapshot = controller.getSnapshot();
    controller.reconcile(entries);

    expect(notifications).toBe(1);
    expect(controller.getSnapshot()).toBe(firstSnapshot);
    unsubscribe();
    controller.dispose();
  });

  it("rebuilds only the changed target and aborts 2 -> 1 -> 0 with stale resolve ignored", async () => {
    const pending: Array<{
      buildKey: string;
      resolve: (result: FdmCuboidBuildResult) => void;
      signal: AbortSignal;
    }> = [];
    const controller = createFdmCuboidBatchBuildController(
      (_request, options) =>
        new Promise((resolve) => {
          if (!options) throw new Error("batch build options are required");
          pending.push({
            buildKey: options?.buildKey ?? "missing",
            resolve,
            signal: options.signal!,
          });
        }),
    );

    controller.reconcile([entry("bottom", "bottom:r1"), entry("top", "top:r1")]);
    expect(pending.map((job) => job.buildKey)).toEqual(["bottom:r1", "top:r1"]);
    expect(controller.getActiveBuildCount()).toBe(2);

    controller.reconcile([entry("bottom", "bottom:r1"), entry("top", "top:r2")]);
    expect(pending.map((job) => job.buildKey)).toEqual([
      "bottom:r1",
      "top:r1",
      "top:r2",
    ]);
    expect(pending[0]?.signal.aborted).toBe(false);
    expect(pending[1]?.signal.aborted).toBe(true);
    expect(controller.getActiveBuildCount()).toBe(2);

    pending[1]?.resolve(EMPTY_RESULT);
    await Promise.resolve();
    expect(controller.getSnapshot().get("top")?.buildKey).toBe("top:r2");
    expect(controller.getSnapshot().get("top")?.status).toBe("pending");

    controller.reconcile([entry("bottom", "bottom:r1")]);
    expect(pending[2]?.signal.aborted).toBe(true);
    expect(controller.getActiveBuildCount()).toBe(1);
    expect([...controller.getSnapshot().keys()]).toEqual(["bottom"]);

    controller.dispose();
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(controller.getActiveBuildCount()).toBe(0);
    expect(controller.getSnapshot().size).toBe(0);
  });

  it("keeps a ready topology model when a same-carrier vectors-only build resolves", async () => {
    const pending: Array<{
      buildKey: string;
      resolve: (result: FdmCuboidBuildResult) => void;
    }> = [];
    const controller = createFdmCuboidBatchBuildController(
      (_request, options) =>
        new Promise((resolve) => {
          pending.push({
            buildKey: options?.buildKey ?? "missing",
            resolve,
          });
        }),
    );
    const topologyModel = {} as NonNullable<FdmCuboidBuildResult["model"]>;

    controller.reconcile([
      { ...entry("airbox", "airbox:topology"), topologyKey: "carrier" },
    ]);
    pending[0]?.resolve({
      model: topologyModel,
      vectorCellIndices: null,
      vectorSegments: null,
    });
    await Promise.resolve();

    controller.reconcile([
      { ...entry("airbox", "airbox:vectors"), topologyKey: "carrier", vectorOnly: {
        anchors: new Float32Array([0, 0, 0]),
        cellIndices: new Uint32Array([0]),
        gridShape: [1, 1, 1],
      } },
    ]);
    pending[1]?.resolve({
      model: null,
      vectorCellIndices: new Uint32Array([0]),
      vectorSegments: new Float32Array(7),
    });
    await Promise.resolve();

    expect(controller.getSnapshot().get("airbox")?.result?.model).toBe(
      topologyModel,
    );
    controller.dispose();
  });
});
