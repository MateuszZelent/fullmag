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

  it("returns null when there is no selection kind", () => {
    expect(resolveInspectorPanel({ kind: null })).toBeNull();
  });
});
