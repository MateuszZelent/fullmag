import { describe, expect, it } from "vitest";
import type { FrozenSpinsSelectionExpression } from "@/kernel/api/apiTypes";
import { selectionReferenceCatalog, selectionReferenceIssue, selectionUnsupportedReason } from "./selectionReferenceCatalog";

const scene = {
  objects: [
    { id: "film/%2F", name: "Film", regions: [{ region_id: "edge,%25", name: "Edge" }, { name: "No identity" }] },
    { id: "other", regions: [{ region_id: "other-edge", name: "Edge" }] },
  ],
  selections: [{ id: "selection/%25", name: "Named" }],
};
const catalog = selectionReferenceCatalog(scene, true);

describe("selector reference catalog", () => {
  it("preserves opaque IDs and never derives a region ID from its name", () => {
    expect(catalog.objects[0]).toEqual({ id: "film/%2F", label: "Film (film/%2F)", regions: [{ id: "edge,%25", label: "Edge (edge,%25)" }] });
    expect(catalog.selections[0]).toEqual({ id: "selection/%25", label: "Named (selection/%25)" });
  });
  it("uses only regions belonging to the selected object", () => {
    expect(selectionReferenceIssue({ kind: "in_region", object_id: "film/%2F", region_id: "other-edge" }, catalog)).toContain("unavailable for this object");
    expect(selectionReferenceIssue({ kind: "in_region", object_id: "film/%2F", region_id: "edge,%25" }, catalog)).toBeUndefined();
  });
  it("does not treat retained catalog data as current", () => {
    expect(selectionReferenceIssue({ kind: "in_object", object_id: "film/%2F" }, { ...catalog, ready: false })).toContain("current scene catalog");
  });
  it("requires an explicit existing named selection without claiming graph validation", () => {
    expect(selectionReferenceIssue({ kind: "ref", selection_id: "" }, catalog)).toContain("cannot be empty");
    expect(selectionReferenceIssue({ kind: "ref", selection_id: "missing" }, catalog)).toContain("unavailable");
    expect(selectionReferenceIssue({ kind: "ref", selection_id: "selection/%25" }, catalog)).toBeUndefined();
  });
  it("treats omitted selections as an empty catalog", () => {
    expect(selectionReferenceCatalog({ objects: [] }, true).selections).toEqual([]);
  });
  it("checks references recursively, including coordinate frames", () => {
    expect(selectionReferenceIssue({ kind: "not", expression: { kind: "in_object", object_id: "missing" } }, catalog)).toContain("unavailable");
    expect(selectionReferenceIssue({ kind: "between", lower: 0, upper: 1, closed: "both", value: { kind: "coordinate", component: "x", frame: { kind: "object", object_id: "missing" } } }, catalog)).toContain("Frame object ID");
  });
  it("preserves unsupported kinds without replacing their AST", () => {
    const future = { kind: "future_selector", opaque: { keep: true } } as unknown as FrozenSpinsSelectionExpression;
    const before = JSON.stringify(future);
    expect(selectionUnsupportedReason(future)).toContain("preserved");
    expect(JSON.stringify(future)).toBe(before);
  });
  it("preserves a future scalar inside an otherwise known selector", () => {
    const expression = { kind: "between", lower: 0, upper: 1, closed: "both", value: { kind: "future_scalar", keep: true } } as unknown as FrozenSpinsSelectionExpression;
    expect(selectionUnsupportedReason(expression)).toContain("scalar kind is unsupported");
  });
  it("bounds inspection of deeply nested expressions", () => {
    let expression: FrozenSpinsSelectionExpression = { kind: "all_magnetic" };
    for (let index = 0; index < 65; index++) expression = { kind: "not", expression };
    expect(selectionUnsupportedReason(expression)).toContain("depth exceeds");
  });
  it("recognizes nested unqualified imported-solid occupancy", () => {
    const expression: FrozenSpinsSelectionExpression = {
      kind: "inside_geometry", frame: { kind: "world" }, sampling: { kind: "dof_point" },
      boundary: { kind: "inclusive", absolute_tolerance_m: 0, relative_tolerance: 0 },
      geometry: { kind: "affine", geometry: { kind: "imported_solid", asset_id: "opaque/asset" }, translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1], scale: [1, 1, 1], pivot_m: [0, 0, 0] },
    };
    expect(selectionUnsupportedReason(expression)).toContain("not qualified");
    expect(selectionReferenceIssue(expression, catalog)).toContain("read-only");
  });
});
