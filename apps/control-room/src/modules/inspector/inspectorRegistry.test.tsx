import { describe, expect, it } from "vitest";

import { resolveInspectorPanel } from "./inspectorRegistry";

describe("inspectorRegistry", () => {
  it("resolves geometry object selections to the geometry object panel", () => {
    expect(resolveInspectorPanel({ kind: "object.root" })?.id).toBe(
      "geometry-object",
    );
    expect(resolveInspectorPanel({ kind: "object.geometry" })?.id).toBe(
      "geometry-object",
    );
  });

  it("resolves object physics selections to the physics interaction panel", () => {
    expect(resolveInspectorPanel({ kind: "object.physics" })?.id).toBe(
      "physics-interaction",
    );
  });

  it("resolves object material selections to the material assignment panel", () => {
    expect(resolveInspectorPanel({ kind: "object.material" })?.id).toBe(
      "object-material",
    );
    expect(resolveInspectorPanel({ kind: "object.magnetic-parameters" })?.id).toBe(
      "object-material",
    );
  });

  it("resolves object region and magnetic texture groups", () => {
    expect(resolveInspectorPanel({ kind: "object.regions" })?.id).toBe(
      "object-regions",
    );
    expect(resolveInspectorPanel({ kind: "object.magnetic-texture" })?.id).toBe(
      "object-magnetic-texture",
    );
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.asset" })?.id,
    ).toBe("object-magnetic-texture");
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.load" })?.id,
    ).toBe("object-magnetic-texture");
    expect(
      resolveInspectorPanel({ kind: "object.magnetic-texture.transform" })?.id,
    ).toBe("object-magnetic-texture");
    expect(
      resolveInspectorPanel({ kind: "object.region-magnetic-texture" })?.id,
    ).toBe("object-magnetic-texture");
  });

  it("resolves object mesh selections to the object mesh policy panel", () => {
    expect(resolveInspectorPanel({ kind: "object.mesh" })?.id).toBe(
      "object-mesh-policy",
    );
  });

  it("falls back to the placeholder panel for known but unsupported selections", () => {
    expect(resolveInspectorPanel({ kind: "results.field_quantity" })?.id).toBe(
      "placeholder",
    );
  });

  it("resolves object and airbox visualization selections to the visualization panel", () => {
    expect(resolveInspectorPanel({ kind: "object.visualization" })?.id).toBe(
      "object-visualization",
    );
    expect(resolveInspectorPanel({ kind: "airbox.visualization" })?.id).toBe(
      "object-visualization",
    );
  });

  it("resolves Airbox mesh policy selections to the Airbox mesh policy panel", () => {
    expect(resolveInspectorPanel({ kind: "airbox.mesh" })?.id).toBe(
      "airbox-mesh-policy",
    );
  });

  it("resolves Airbox mesh quality selections to the Airbox mesh quality panel", () => {
    expect(resolveInspectorPanel({ kind: "airbox.mesh-quality" })?.id).toBe(
      "airbox-mesh-quality",
    );
  });

  it("resolves cross-section selections to the cross-section inspector", () => {
    expect(resolveInspectorPanel({ kind: "mesh.cross-section" })?.id).toBe(
      "cross-section",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.draft" })?.id).toBe(
      "cross-section",
    );
    expect(resolveInspectorPanel({ kind: "mesh.cross-section.plot" })?.id).toBe(
      "cross-section",
    );
  });

  it("returns null when there is no selection kind", () => {
    expect(resolveInspectorPanel({ kind: null })).toBeNull();
  });
});
