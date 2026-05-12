import { describe, expect, it } from "vitest";

import { inspectorForNodeKind, PanelKey } from "../inspectorRegistry";
import { resolveNodeHandle } from "../nodeHandleResolver";

describe("inspectorRegistry", () => {
  it("keeps geometry and mesh inspectors split for scene objects", () => {
    expect(inspectorForNodeKind(resolveNodeHandle("obj-ring")).panelKey).toBe(PanelKey.GEOMETRY);
    expect(inspectorForNodeKind(resolveNodeHandle("geo-ring")).panelKey).toBe(PanelKey.GEOMETRY);
    expect(inspectorForNodeKind(resolveNodeHandle("geo-ring-mesh")).panelKey).toBe(PanelKey.OBJECT_MESH);
    expect(inspectorForNodeKind(resolveNodeHandle("reg-ring")).panelKey).toBe(PanelKey.REGION);
  });

  it("routes magnetization texture tree nodes to the magnetic texture inspector", () => {
    expect(inspectorForNodeKind(resolveNodeHandle("mag-free")).panelKey).toBe(PanelKey.MATERIAL_MAG);
    expect(inspectorForNodeKind(resolveNodeHandle("mag-free-kind")).panelKey).toBe(PanelKey.MATERIAL_MAG);
    expect(inspectorForNodeKind(resolveNodeHandle("mag-free-transform-scale")).panelKey).toBe(PanelKey.MATERIAL_MAG);
  });

  it("routes builder nodes to dedicated geometry-builder inspectors", () => {
    expect(inspectorForNodeKind(resolveNodeHandle("builder-root")).panelKey).toBe(PanelKey.BUILDER_OVERVIEW);
    expect(inspectorForNodeKind(resolveNodeHandle("builder-universe")).panelKey).toBe(PanelKey.BUILDER_UNIVERSE);
    expect(inspectorForNodeKind(resolveNodeHandle("builder-prim-abc")).panelKey).toBe(PanelKey.BUILDER_PRIMITIVE);
  });
});
