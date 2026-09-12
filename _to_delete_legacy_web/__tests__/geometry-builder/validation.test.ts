/**
 * P1 unit tests — placement validation
 *
 * Verifies:
 * - Box fully inside Universe → withinUniverse=true, no diagnostics.
 * - Box crossing boundary → intersectsUniverseBoundary=true, warning diagnostic.
 * - Box center outside Universe → exceedsUniverse=true, error diagnostic.
 * - suggestedActions populated when primitive crosses boundary.
 * - NaN/Inf in transform → selfInvalid + early return.
 * - Zero-size param → selfInvalid.
 * - Preview-only primitive kind → warning diagnostic.
 * - clampToUniverse returns translation inside Universe.
 */
import { describe, expect, it } from "vitest";

import { validatePlacement, clampToUniverse } from "../../features/geometry-builder/validation/placementValidation";
import type { PrimitiveNode, UniverseNode, Vec3 } from "../../features/geometry-builder/model/types";

// ── Helpers ───────────────────────────────────────────────────

function makeUniverse(size: Vec3 = [1e-6, 1e-6, 1e-6], origin: Vec3 = [0, 0, 0]): UniverseNode {
  return {
    id: "universe",
    kind: "universe",
    boundsMode: "box",
    size,
    origin,
    visibility: true,
    lockTransforms: true,
    policy: "preview_only_block_build",
  };
}

function makeBox(
  translation: Vec3,
  size: Vec3 = [200e-9, 200e-9, 200e-9],
): PrimitiveNode {
  return {
    id: "test-prim",
    kind: "primitive",
    primitiveKind: "box",
    name: "Test Box",
    enabled: true,
    visible: true,
    locked: false,
    transform: { translation, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    params: { kind: "box", data: { size } },
    materialBindingId: null,
    tags: [],
  };
}

// ── Fully inside Universe ─────────────────────────────────────

describe("validatePlacement — box fully inside Universe", () => {
  it("returns withinUniverse=true when box is well inside Universe", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([0, 0, 0]);
    const result = validatePlacement(prim, universe);
    expect(result.withinUniverse).toBe(true);
    expect(result.intersectsUniverseBoundary).toBe(false);
    expect(result.exceedsUniverse).toBe(false);
    expect(result.selfInvalid).toBe(false);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("suggestedActions is empty when box is inside", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([0, 0, 0]);
    expect(validatePlacement(prim, universe).suggestedActions).toHaveLength(0);
  });
});

// ── Crosses boundary (partially outside) ─────────────────────

describe("validatePlacement — box crosses Universe boundary", () => {
  it("sets intersectsUniverseBoundary=true and emits a warning", () => {
    // 1µm Universe centred at origin → bounds ±500nm
    // 200nm box with centre at 450nm → extends to 550nm, crossing +X boundary
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([450e-9, 0, 0]);
    const result = validatePlacement(prim, universe);
    expect(result.intersectsUniverseBoundary).toBe(true);
    // Center (450nm) is inside Universe (+500nm boundary) → warning, not error
    expect(result.exceedsUniverse).toBe(false);
    const warnings = result.diagnostics.filter((d) => d.severity === "warning" && d.code === "crosses_boundary");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("includes expand_universe, move_inside and clip_with_ack suggested actions", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([450e-9, 0, 0]);
    const { suggestedActions } = validatePlacement(prim, universe);
    const kinds = suggestedActions.map((a) => a.kind);
    expect(kinds).toContain("expand_universe");
    expect(kinds).toContain("move_inside");
    expect(kinds).toContain("clip_with_ack");
  });
});

// ── Center outside Universe (exceedsUniverse) ─────────────────

describe("validatePlacement — box center outside Universe", () => {
  it("sets exceedsUniverse=true with error diagnostic", () => {
    // Box centred at 700nm, 200nm size → fully outside +500nm Universe boundary
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([700e-9, 0, 0]);
    const result = validatePlacement(prim, universe);
    expect(result.exceedsUniverse).toBe(true);
    const errors = result.diagnostics.filter((d) => d.severity === "error" && d.code === "out_of_bounds");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("withinUniverse is false when exceedsUniverse", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([700e-9, 0, 0]);
    expect(validatePlacement(prim, universe).withinUniverse).toBe(false);
  });
});

// ── NaN / Infinity guard ──────────────────────────────────────

describe("validatePlacement — NaN/Inf transform", () => {
  it("returns selfInvalid=true and exceedsUniverse=true for NaN translation", () => {
    const universe = makeUniverse();
    const prim = makeBox([NaN, 0, 0]);
    const result = validatePlacement(prim, universe);
    expect(result.selfInvalid).toBe(true);
    expect(result.exceedsUniverse).toBe(true);
    const errors = result.diagnostics.filter((d) => d.code === "invalid_transform");
    expect(errors).toHaveLength(1);
  });

  it("returns selfInvalid=true for Infinity in scale", () => {
    const universe = makeUniverse();
    const prim: PrimitiveNode = {
      ...makeBox([0, 0, 0]),
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [Infinity, 1, 1] },
    };
    expect(validatePlacement(prim, universe).selfInvalid).toBe(true);
  });
});

// ── Zero-size param ───────────────────────────────────────────

describe("validatePlacement — zero-size param", () => {
  it("cylinder with radius=0 is selfInvalid", () => {
    const universe = makeUniverse();
    const prim: PrimitiveNode = {
      id: "cyl",
      kind: "primitive",
      primitiveKind: "cylinder",
      name: "Cylinder",
      enabled: true,
      visible: true,
      locked: false,
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      params: { kind: "cylinder", data: { radius: 0, height: 100e-9, axis: "z" } },
      materialBindingId: null,
      tags: [],
    };
    const result = validatePlacement(prim, universe);
    expect(result.selfInvalid).toBe(true);
    const errors = result.diagnostics.filter((d) => d.code === "zero_size");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("degenerate scale is selfInvalid", () => {
    const universe = makeUniverse();
    const prim: PrimitiveNode = {
      ...makeBox([0, 0, 0]),
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [0, 1, 1] },
    };
    const result = validatePlacement(prim, universe);
    expect(result.selfInvalid).toBe(true);
    const errors = result.diagnostics.filter((d) => d.code === "degenerate_scale");
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ── Preview-only warning ──────────────────────────────────────

describe("validatePlacement — preview-only primitive kinds", () => {
  it("sphere emits preview_only_unsupported warning", () => {
    const universe = makeUniverse();
    const prim: PrimitiveNode = {
      id: "sph",
      kind: "primitive",
      primitiveKind: "sphere",
      name: "Sphere",
      enabled: true,
      visible: true,
      locked: false,
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      params: { kind: "sphere", data: { radius: 50e-9 } },
      materialBindingId: null,
      tags: [],
    };
    const result = validatePlacement(prim, universe);
    const warnings = result.diagnostics.filter((d) => d.code === "preview_only_unsupported");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe("warning");
  });

  it("box does NOT emit preview_only_unsupported warning", () => {
    const universe = makeUniverse();
    const prim = makeBox([0, 0, 0]);
    const result = validatePlacement(prim, universe);
    const warnings = result.diagnostics.filter((d) => d.code === "preview_only_unsupported");
    expect(warnings).toHaveLength(0);
  });
});

// ── clampToUniverse ───────────────────────────────────────────

describe("clampToUniverse", () => {
  it("returns translation inside Universe for a box that partially exceeds bounds", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([600e-9, 0, 0]); // centre at 600nm, half-size 100nm → exceeds +500nm
    const clamped = clampToUniverse(prim, universe);
    // After clamping, AABB max should equal Universe max (500nm)
    expect(clamped[0] + 100e-9).toBeCloseTo(500e-9);
  });

  it("returns unchanged translation when already inside", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const prim = makeBox([0, 0, 0]);
    const clamped = clampToUniverse(prim, universe);
    expect(clamped[0]).toBeCloseTo(0);
    expect(clamped[1]).toBeCloseTo(0);
    expect(clamped[2]).toBeCloseTo(0);
  });
});
