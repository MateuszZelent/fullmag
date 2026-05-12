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

  it("returns null when there is no selection kind", () => {
    expect(resolveInspectorPanel({ kind: null })).toBeNull();
  });
});
