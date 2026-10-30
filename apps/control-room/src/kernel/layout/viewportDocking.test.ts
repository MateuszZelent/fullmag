import { describe, expect, it } from "vitest";
import { hitTestDockEdge, planViewportDock, type DockEdge } from "./viewportDocking";

const area = { left: 300, top: 200, width: 800, height: 600 };
describe("viewport edge docking", () => {
  it.each<[DockEdge, number, number]>([
    ["left", 304, 500], ["right", 1096, 500], ["top", 700, 204], ["bottom", 700, 796],
  ])("detects %s in client coordinates", (edge, x, y) => expect(hitTestDockEdge(area, { x, y })).toBe(edge));
  it("does not snap in the interior, above the toolbar or far outside the workspace", () => {
    for (const point of [{ x: 700, y: 500 }, { x: 700, y: 250 }, { x: 200, y: 500 }, { x: 700, y: 170 }])
      expect(hitTestDockEdge(area, point)).toBeNull();
    expect(hitTestDockEdge(area, { x: 290, y: 500 })).toBe("left");
  });
  it("rejects empty or invalid areas and resolves corners by nearest edge", () => {
    expect(hitTestDockEdge({ ...area, width: 0 }, { x: 300, y: 200 })).toBeNull();
    expect(hitTestDockEdge(area, { x: NaN, y: 200 })).toBeNull();
    expect(hitTestDockEdge(area, { x: 304, y: 214 })).toBe("left");
    expect(hitTestDockEdge(area, { x: 320, y: 202 })).toBe("top");
  });
  it.each<[DockEdge, string, string, string]>([
    ["left", "mode", "chart", "beside"], ["right", "chart", "mode", "beside"],
    ["top", "mode", "chart", "below"], ["bottom", "chart", "mode", "below"],
  ])("places a mode on the %s and keeps its chart", (edge, primaryId, companionId, placement) => {
    expect(planViewportDock("mode", edge, ["chart", "mode"], ["chart", "mode"], ["chart"]))
      .toEqual({ primaryId, companionId, placement, displacedIds: [] });
  });
  it("redocks both floating peers and does not revive hidden neighbours", () => {
    expect(planViewportDock("mode", "left", ["chart", "mode"], ["chart", "mode"], []).companionId).toBe("chart");
    expect(planViewportDock("mode", "left", ["chart", "mode"], ["mode"], []))
      .toEqual({ primaryId: "mode", companionId: null, placement: "beside", displacedIds: [] });
  });
  it("preserves a displaced visible view as a floating window", () => {
    expect(planViewportDock("slice", "right", ["chart", "mode"], ["chart", "mode", "slice"], ["chart", "mode"]))
      .toEqual({ primaryId: "chart", companionId: "slice", placement: "beside", displacedIds: ["mode"] });
  });
});
