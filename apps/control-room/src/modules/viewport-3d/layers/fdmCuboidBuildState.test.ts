import { describe, expect, it } from "vitest";

import type {
  FdmCuboidBuildRequest,
  FdmCuboidBuildResult,
} from "./fdmCuboidBuildModel";
import {
  resolveFdmCuboidBuildState,
  type FdmCuboidBuildSnapshot,
} from "./fdmCuboidBuildState";

const requestA = {} as FdmCuboidBuildRequest;
const resultA = {} as FdmCuboidBuildResult;

describe("resolveFdmCuboidBuildState", () => {
  it("returns pending with no result when the snapshot belongs to an old build key", () => {
    expect(
      resolveFdmCuboidBuildState({
        currentBuildKey: "B",
        snapshot: {
          buildKey: "A",
          error: null,
          request: requestA,
          result: resultA,
          status: "ready",
        },
      }),
    ).toEqual({ buildKey: "B", error: null, result: null, status: "pending" });
  });

  it("keeps an old completion pending after the current key advances", () => {
    const lateCompletion: FdmCuboidBuildSnapshot = {
      buildKey: "A",
      error: null,
      request: requestA,
      result: resultA,
      status: "ready",
    };

    expect(
      resolveFdmCuboidBuildState({ currentBuildKey: "B", snapshot: lateCompletion }),
    ).toEqual({ buildKey: "B", error: null, result: null, status: "pending" });
  });

  it("exposes a non-abort rejection for the current build key without a result", () => {
    const error = new Error("worker unavailable");

    expect(
      resolveFdmCuboidBuildState({
        currentBuildKey: "B",
        snapshot: {
          buildKey: "B",
          error,
          request: requestA,
          result: null,
          status: "error",
        },
      }),
    ).toEqual({ buildKey: "B", error, result: null, status: "error" });
  });
});
