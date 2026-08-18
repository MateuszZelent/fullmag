import { describe, expect, it } from "vitest";

import {
  createFdmCuboidBuildStateController,
  resolveFdmCuboidBuildState,
} from "./fdmCuboidBuildState";
import type { FdmCuboidBuildResult } from "./fdmCuboidBuildModel";

const resultA = {} as FdmCuboidBuildResult;
const topologyModel = {} as FdmCuboidBuildResult["model"];

describe("resolveFdmCuboidBuildState", () => {
  it("keeps the previous model visible while a same-topology replacement starts", () => {
    expect(
      resolveFdmCuboidBuildState({
        currentBuildKey: "B",
        currentTopologyKey: "carrier-a",
        snapshot: {
          buildKey: "A",
          error: null,
          result: resultA,
          status: "ready",
          topologyKey: "carrier-a",
        },
      }),
    ).toEqual({ buildKey: "B", error: null, result: resultA, status: "pending" });
  });

  it("does not display a previous model after topology changes", () => {
    expect(
      resolveFdmCuboidBuildState({
        currentBuildKey: "B",
        currentTopologyKey: "carrier-b",
        snapshot: {
          buildKey: "A",
          error: null,
          result: resultA,
          status: "ready",
          topologyKey: "carrier-a",
        },
      }).result,
    ).toBeNull();
  });

  it("keeps B pending when A resolves after B begins", () => {
    const controller = createFdmCuboidBuildStateController();

    controller.begin("A");
    controller.begin("B");
    controller.resolve("A", resultA);

    expect(controller.getSnapshot()).toEqual({
      buildKey: "B",
      error: null,
      result: null,
      status: "pending",
      topologyKey: null,
    });
  });

  it("suppresses an abort rejection for the current build key", () => {
    const controller = createFdmCuboidBuildStateController();

    controller.begin("B");
    controller.reject("B", new DOMException("aborted", "AbortError"));

    expect(controller.getSnapshot()).toEqual({
      buildKey: "B",
      error: null,
      result: null,
      status: "pending",
      topologyKey: null,
    });
  });

  it("exposes a non-abort rejection for the current build key without a result", () => {
    const error = new Error("worker unavailable");
    const controller = createFdmCuboidBuildStateController();

    controller.begin("B");
    controller.reject("B", error);

    expect(controller.getSnapshot()).toEqual({
      buildKey: "B",
      error,
      result: null,
      status: "error",
      topologyKey: null,
    });
  });

  it("retains the last compatible result while a field-only rebuild is pending", () => {
    const controller = createFdmCuboidBuildStateController();

    controller.begin("topology-a", "carrier-a");
    controller.resolve("topology-a", resultA);
    controller.begin("field-b", "carrier-a");

    expect(controller.getSnapshot()).toEqual({
      buildKey: "field-b",
      error: null,
      result: resultA,
      status: "pending",
      topologyKey: "carrier-a",
    });
  });

  it("does not retain a result when the carrier identity changes", () => {
    const controller = createFdmCuboidBuildStateController();

    controller.begin("topology-a", "carrier-a");
    controller.resolve("topology-a", resultA);
    controller.begin("topology-b", "carrier-b");

    expect(controller.getSnapshot().result).toBeNull();
  });

  it("retains the immutable topology model when a vectors-only result has no model", () => {
    const controller = createFdmCuboidBuildStateController();
    const topologyResult: FdmCuboidBuildResult = {
      model: topologyModel,
      vectorCellIndices: null,
      vectorSegments: null,
    };
    const vectorsOnlyResult: FdmCuboidBuildResult = {
      model: null,
      vectorCellIndices: new Uint32Array([3]),
      vectorSegments: new Float32Array(7),
    };

    controller.begin("topology", "carrier");
    controller.resolve("topology", topologyResult);
    controller.begin("vectors:r2", "carrier");
    controller.resolve("vectors:r2", vectorsOnlyResult);

    expect(controller.getSnapshot().result).toEqual({
      model: topologyModel,
      vectorCellIndices: vectorsOnlyResult.vectorCellIndices,
      vectorSegments: vectorsOnlyResult.vectorSegments,
    });
  });
});
