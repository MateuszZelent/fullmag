import { describe, expect, it } from "vitest";

import { contextualTabsForSelection, ribbonTabForSelectedNode } from "../RibbonBar";

describe("RibbonBar selection routing", () => {
  it("routes selected nodes through typed selection targets", () => {
    expect(ribbonTabForSelectedNode("physics-object-1")).toBe("Physics");
    expect(ribbonTabForSelectedNode("mat-object-1")).toBe("Materials");
    expect(ribbonTabForSelectedNode("obj-object-1")).toBe("Geometry");
    expect(ribbonTabForSelectedNode("mesh-object-1")).toBe("Mesh");
    expect(ribbonTabForSelectedNode("stage-relax")).toBe("Study");
    expect(ribbonTabForSelectedNode("res-spectrum")).toBe("Results");
  });

  it("does not infer core tabs from arbitrary substrings", () => {
    expect(ribbonTabForSelectedNode("not-a-physics-node")).toBe("Home");
    expect(ribbonTabForSelectedNode("object-study-note")).toBe("Home");
  });

  it("resolves contextual tabs from typed targets", () => {
    expect(contextualTabsForSelection({ selectedNodeId: "outer-boundary" })).toEqual([
      { id: "interface", label: "Interface" },
    ]);
    expect(contextualTabsForSelection({ selectedNodeId: "work-plane-main" })).toEqual([
      { id: "work-plane", label: "Work Plane" },
    ]);
    expect(contextualTabsForSelection({ selectedNodeId: "universe-mesh-statistics" })).toEqual([
      { id: "mesh-quality", label: "Mesh Statistics" },
    ]);
    expect(contextualTabsForSelection({ selectedNodeId: "mesh-pipeline" })).toEqual([
      { id: "mesh-quality", label: "Mesh Quality" },
    ]);
  });
});
