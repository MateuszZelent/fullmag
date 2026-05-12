import { describe, expect, it } from "vitest";

import {
  mergeSceneFrameBounds,
  resolveDimensionFrameBounds,
} from "../useFemSceneGeometry";

describe("dimension frame bounds", () => {
  it("uses the dynamic scene bounds when they are larger than the world frame", () => {
    const frame = resolveDimensionFrameBounds({
      dynamicExtent: [120, 80, 60],
      worldExtent: [100, 100, 50],
      worldCenter: [0, 0, 0],
    });

    expect(frame.extent).toEqual([120, 100, 60]);
    expect(frame.center).toEqual([0, 0, 0]);
  });

  it("unions offset dynamic and world bounds for a responsive frame", () => {
    const frame = mergeSceneFrameBounds(
      { extent: [20, 20, 20], center: [25, 0, 0] },
      { extent: [10, 10, 10], center: [-10, 0, 0] },
    );

    expect(frame.extent).toEqual([50, 20, 20]);
    expect(frame.center).toEqual([10, 0, 0]);
  });
});
