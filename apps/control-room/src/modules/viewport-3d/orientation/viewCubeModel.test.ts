import { describe, expect, it } from "vitest";

import {
  buildViewCubeTargetMap,
  getViewCubeAxisLabels,
} from "./viewCubeModel";

describe("view cube model", () => {
  it("keeps v1-compatible axis labels for the default scene convention", () => {
    expect(getViewCubeAxisLabels("identity")).toEqual({
      x: "+X",
      y: "+Y",
      z: "+Z",
    });
  });

  it("builds face, edge, and corner snap targets", () => {
    const targets = buildViewCubeTargetMap("identity");

    expect(targets.size).toBe(26);
    expect(targets.get("right")?.direction).toEqual([1, 0, 0]);
    expect(targets.get("top")?.direction).toEqual([0, 1, 0]);
    expect(targets.get("front")?.direction).toEqual([0, 0, 1]);
    expect(targets.get("right-top")?.direction).toEqual([1, 1, 0]);
    expect(targets.get("right-top-front")?.direction).toEqual([1, 1, 1]);
  });

  it("maps labels through the v1 swapYZ convention", () => {
    expect(getViewCubeAxisLabels("swapYZ")).toEqual({
      x: "+X",
      y: "+Z",
      z: "+Y",
    });
  });
});
