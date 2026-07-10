import { describe, expect, it } from "vitest";

import {
  createFdmCuboidBuildStateController,
  resolveFdmCuboidBuildState,
  type FdmCuboidBuildSnapshot,
} from "./fdmCuboidBuildState";
import type { FdmCuboidBuildResult } from "./fdmCuboidBuildModel";

const resultA = {} as FdmCuboidBuildResult;

describe("resolveFdmCuboidBuildState", () => {
  it("returns pending with no result when the snapshot belongs to an old build key", () => {
    expect(
      resolveFdmCuboidBuildState({
        currentBuildKey: "B",
        snapshot: {
          buildKey: "A",
          error: null,
          result: resultA,
          status: "ready",
        },
      }),
    ).toEqual({ buildKey: "B", error: null, result: null, status: "pending" });
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
    });
  });
});
