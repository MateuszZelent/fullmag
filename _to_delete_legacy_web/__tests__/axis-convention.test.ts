import { describe, expect, it } from "vitest";

import {
  applyAxisConventionVec3,
  axisLabelsForConvention,
  sceneAxisDescriptor,
} from "../components/preview/transform/axisConvention";

describe("axis convention", () => {
  it("keeps physical XYZ aligned with scene XYZ", () => {
    expect(applyAxisConventionVec3([1, 2, 3], "identity")).toEqual([1, 2, 3]);
    expect(axisLabelsForConvention("identity")).toEqual(["x", "y", "z"]);
  });

  it("describes canonical axis labels and colors", () => {
    expect(sceneAxisDescriptor(0, "identity")).toEqual({ text: "X", color: "#e65050" });
    expect(sceneAxisDescriptor(1, "identity")).toEqual({ text: "Y", color: "#50c850" });
    expect(sceneAxisDescriptor(2, "identity")).toEqual({ text: "Z", color: "#5090e6" });
  });
});
