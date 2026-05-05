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

  it("routes builder nodes to dedicated geometry-builder inspectors", () => {
    expect(inspectorForNodeKind(resolveNodeHandle("builder-root")).panelKey).toBe(PanelKey.BUILDER_OVERVIEW);
    expect(inspectorForNodeKind(resolveNodeHandle("builder-universe")).panelKey).toBe(PanelKey.BUILDER_UNIVERSE);
    expect(inspectorForNodeKind(resolveNodeHandle("builder-prim-abc")).panelKey).toBe(PanelKey.BUILDER_PRIMITIVE);
  });
});
