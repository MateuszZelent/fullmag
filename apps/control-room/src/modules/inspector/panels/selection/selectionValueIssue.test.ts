import { describe, expect, it } from "vitest";
import type { FrozenSpinsSelectionExpression, SelectionGeometryPredicate } from "@/kernel/api/apiTypes";
import { selectionValueIssue } from "./selectionValueIssue";

const sphere: SelectionGeometryPredicate = { kind: "sphere", center_m: [0, 0, 0], radius_m: 1 };
const affine: SelectionGeometryPredicate = { kind: "affine", geometry: sphere, translation_m: [0, 0, 0], pivot_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1], scale: [1, 1, 1] };
const inside = (geometry: SelectionGeometryPredicate): FrozenSpinsSelectionExpression => ({
  kind: "inside_geometry", geometry, frame: { kind: "world" }, sampling: { kind: "dof_point" },
  boundary: { kind: "inclusive", absolute_tolerance_m: 0, relative_tolerance: 0 },
});

describe("local selector value requirements", () => {
  it.each([
    { geometry: { ...sphere, radius_m: 0 } }, { geometry: { ...sphere, radius_m: -1 } },
    { geometry: { ...sphere, center_m: [Infinity, 0, 0] } },
    { geometry: { kind: "box", center_m: [0, 0, 0], size_m: [1, 0, 1] } },
    { geometry: { kind: "ellipsoid", center_m: [0, 0, 0], radii_m: [1, -1, 1] } },
    { geometry: { kind: "cylinder", center_m: [0, 0, 0], axis: [0, 0, 1], radius_m: 1, height_m: 0 } },
    { geometry: { kind: "cylinder", center_m: [0, 0, 0], axis: [0, 0, 2], radius_m: 1, height_m: 1 } },
    { geometry: { ...affine, scale: [1, 0, 1] } }, { geometry: { ...affine, rotation_xyzw: [0, 0, 0, 0] } },
    { geometry: { ...affine, rotation_xyzw: [0, 0, 0, 2] } },
  ] satisfies { geometry: SelectionGeometryPredicate }[])("rejects invalid geometry $geometry without rewriting it", ({ geometry }) => {
    const original = structuredClone(geometry);
    expect(selectionValueIssue(inside(geometry))).toBeTruthy();
    expect(geometry).toEqual(original);
  });

  it("preserves negative invertible scales, tiny positive sizes and finite zero coordinates", () => {
    expect(selectionValueIssue(inside({ ...affine, scale: [-1, 1e-9, 1] }))).toBeUndefined();
    expect(selectionValueIssue(inside({ ...sphere, radius_m: 1e-300 }))).toBeUndefined();
    expect(selectionValueIssue(inside(sphere))).toBeUndefined();
  });

  it("checks nested geometry and scalar axes through boolean expressions", () => {
    const expression: FrozenSpinsSelectionExpression = { kind: "not", expression: inside({ kind: "union", a: sphere, b: { ...sphere, radius_m: 0 } }) };
    expect(selectionValueIssue(expression)).toContain(".b.radius_m");
    expect(selectionValueIssue({ kind: "compare", op: "ge", lhs: { kind: "abs", value: { kind: "magnetization_dot", axis: [0, 0, 0] } }, rhs: { kind: "constant", value: 0 } })).toContain("normalized");
  });

  it("uses the canonical squared-norm tolerance without normalizing inputs", () => {
    const compare = (axis: number[]): FrozenSpinsSelectionExpression => ({ kind: "compare", op: "ge", lhs: { kind: "magnetization_dot", axis }, rhs: { kind: "constant", value: 0 } });
    expect(selectionValueIssue(compare([0, 0, 1 + 1e-13]))).toBeUndefined();
    expect(selectionValueIssue(compare([0, 0, 1 + 1e-11]))).toContain("normalized");
    expect(selectionValueIssue(compare([1e308, 0, 0]))).toContain("normalized");
  });

  it("requires positive approx tolerance while allowing explicit zero in compare and bounds", () => {
    const value = { kind: "constant" as const, value: 0 };
    const approximate: FrozenSpinsSelectionExpression = { kind: "approx", value, target: value, atol: 0, rtol: 0 };
    expect(selectionValueIssue(approximate)).toContain("at least one positive");
    expect(selectionValueIssue({ ...approximate, rtol: 1e-12 })).toBeUndefined();
    expect(selectionValueIssue({ ...approximate, atol: -1 })).toContain("non-negative");
    expect(selectionValueIssue({ kind: "compare", lhs: value, rhs: value, op: "ge", tolerance: { atol: 0, rtol: 0 } })).toBeUndefined();
    expect(selectionValueIssue({ kind: "compare", lhs: value, rhs: value, op: "ge", tolerance: { atol: 1, rtol: 0 } })).toContain("zero");
    expect(selectionValueIssue({ kind: "between", value, lower: 0, upper: 0, closed: "both" })).toBeUndefined();
  });

  it("checks nonnegative boundary tolerances and XOR arity", () => {
    const expression = inside(sphere);
    if (expression.kind !== "inside_geometry") throw new Error("Wrong fixture");
    expect(selectionValueIssue({ ...expression, boundary: { ...expression.boundary, relative_tolerance: -1 } })).toContain("non-negative");
    expect(selectionValueIssue({ kind: "xor", expressions: [{ kind: "all_magnetic" }] })).toContain("at least two");
    expect(selectionValueIssue({ kind: "xor", expressions: [{ kind: "all_magnetic" }, { kind: "all_magnetic" }] })).toBeUndefined();
  });
});
