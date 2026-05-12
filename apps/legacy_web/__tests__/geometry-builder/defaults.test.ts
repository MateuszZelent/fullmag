/**
 * P1 unit tests — geometry-builder defaults
 *
 * Verifies size clamping, per-kind parameter factories, and smart placement.
 */
import { describe, expect, it } from "vitest";

import {
  defaultTargetSize,
  defaultBoxParams,
  defaultCylinderParams,
  defaultDiskParams,
  defaultSphereParams,
  createDefaultPrimitive,
  MIN_DEFAULT_SIZE_M,
  MAX_DEFAULT_SIZE_M,
} from "../../features/geometry-builder/model/defaults";
import type {
  PrimitiveNode,
  Vec3,
  UniverseNode,
} from "../../features/geometry-builder/model/types";
import { IDENTITY_TRANSFORM } from "../../features/geometry-builder/model/types";

// ── Helpers ───────────────────────────────────────────────────

function makeUniverse(size: Vec3): UniverseNode {
  return {
    id: "universe",
    kind: "universe",
    boundsMode: "box",
    size,
    origin: [0, 0, 0],
    visibility: true,
    lockTransforms: true,
    policy: "preview_only_block_build",
  };
}

function freshCounters() {
  return { box: 0, cylinder: 0, sphere: 0, disk: 0, triangular_prism: 0 };
}

// ── defaultTargetSize ─────────────────────────────────────────

describe("defaultTargetSize", () => {
  it("returns MAX_DEFAULT_SIZE_M for a 1µm isotropic universe (1µm × 0.25 > 200nm)", () => {
    // 1e-6 * 0.25 = 250nm, clamped to MAX = 200nm
    expect(defaultTargetSize([1e-6, 1e-6, 1e-6])).toBeCloseTo(MAX_DEFAULT_SIZE_M);
  });

  it("returns raw fraction when it falls between min and max", () => {
    // 400nm universe → 400nm × 0.25 = 100nm, within [20nm, 200nm]
    expect(defaultTargetSize([400e-9, 400e-9, 400e-9])).toBeCloseTo(100e-9);
  });

  it("clamps to MIN_DEFAULT_SIZE_M for a very small universe", () => {
    // 10nm universe → 10nm × 0.25 = 2.5nm, clamped to 20nm
    expect(defaultTargetSize([10e-9, 10e-9, 10e-9])).toBeCloseTo(MIN_DEFAULT_SIZE_M);
  });

  it("returns MAX_DEFAULT_SIZE_M for an invalid (zero) universe dimension", () => {
    expect(defaultTargetSize([0, 1e-6, 1e-6])).toBeCloseTo(MAX_DEFAULT_SIZE_M);
  });

  it("returns MAX_DEFAULT_SIZE_M for a negative universe dimension", () => {
    expect(defaultTargetSize([-1e-6, 1e-6, 1e-6])).toBeCloseTo(MAX_DEFAULT_SIZE_M);
  });

  it("uses the minimum dimension, not the first", () => {
    // min(1µm, 1µm, 80nm) = 80nm → 80nm × 0.25 = 20nm (== MIN)
    const result = defaultTargetSize([1e-6, 1e-6, 80e-9]);
    expect(result).toBeGreaterThanOrEqual(MIN_DEFAULT_SIZE_M - 1e-12);
    expect(result).toBeLessThanOrEqual(MAX_DEFAULT_SIZE_M + 1e-12);
  });
});

// ── Per-kind defaults ─────────────────────────────────────────

describe("defaultBoxParams", () => {
  it("returns a cube with edge ≤ MAX_DEFAULT_SIZE_M for 1µm universe", () => {
    const params = defaultBoxParams([1e-6, 1e-6, 1e-6]);
    expect(params.size[0]).toBeLessThanOrEqual(MAX_DEFAULT_SIZE_M + 1e-12);
    expect(params.size[0]).toEqual(params.size[1]);
    expect(params.size[1]).toEqual(params.size[2]);
  });
});

describe("defaultCylinderParams", () => {
  it("radius equals targetSize / 2", () => {
    const size: Vec3 = [1e-6, 1e-6, 1e-6];
    const s = defaultTargetSize(size);
    const params = defaultCylinderParams(size);
    expect(params.radius).toBeCloseTo(s / 2);
  });

  it("height equals targetSize", () => {
    const size: Vec3 = [400e-9, 400e-9, 400e-9];
    const s = defaultTargetSize(size);
    const params = defaultCylinderParams(size);
    expect(params.height).toBeCloseTo(s);
  });
});

describe("defaultDiskParams", () => {
  it("thickness is at least 1 nm", () => {
    // Even for a 20nm target size: 20nm × 0.1 = 2nm, still ≥ 1nm
    const params = defaultDiskParams([20e-9, 20e-9, 20e-9]);
    expect(params.thickness).toBeGreaterThanOrEqual(1e-9 - 1e-12);
  });

  it("thickness equals max(s * 0.1, 1e-9) for normal sizes", () => {
    // 200nm target → 0.1 × 200nm = 20nm
    const size: Vec3 = [1e-6, 1e-6, 1e-6];
    const s = defaultTargetSize(size); // 200nm
    const params = defaultDiskParams(size);
    expect(params.thickness).toBeCloseTo(Math.max(s * 0.1, 1e-9));
  });
});

// ── createDefaultPrimitive ────────────────────────────────────

describe("createDefaultPrimitive", () => {
  it("places at Universe origin when no existing primitives", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const node = createDefaultPrimitive("box", { universe, existingPrimitives: [] }, freshCounters());
    expect(node.transform.translation[0]).toBeCloseTo(universe.origin[0]);
    expect(node.transform.translation[1]).toBeCloseTo(universe.origin[1]);
    expect(node.transform.translation[2]).toBeCloseTo(universe.origin[2]);
  });

  it("places to the +X side of existing primitives when space is available", () => {
    const universe = makeUniverse([2e-6, 2e-6, 2e-6]);
    // Place an existing 200nm box at the origin
    const s = MAX_DEFAULT_SIZE_M;
    const existing: PrimitiveNode = {
      id: "existing-1",
      kind: "primitive",
      primitiveKind: "box",
      name: "Box 001",
      enabled: true,
      visible: true,
      locked: false,
      transform: { ...IDENTITY_TRANSFORM },
      params: { kind: "box", data: { size: [s, s, s] } },
      materialBindingId: null,
      tags: [],
    };
    const node = createDefaultPrimitive(
      "box",
      { universe, existingPrimitives: [existing] },
      freshCounters(),
    );
    // New box centre should be +X relative to existing box
    expect(node.transform.translation[0]).toBeGreaterThan(existing.transform.translation[0]);
  });

  it("generates deterministic sequential names", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const counters = freshCounters();
    const a = createDefaultPrimitive("box", { universe, existingPrimitives: [] }, counters);
    const b = createDefaultPrimitive("box", { universe, existingPrimitives: [] }, counters);
    expect(a.name).toBe("Box 001");
    expect(b.name).toBe("Box 002");
  });

  it("uses separate counters for different kinds", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const counters = freshCounters();
    const box = createDefaultPrimitive("box", { universe, existingPrimitives: [] }, counters);
    const cyl = createDefaultPrimitive("cylinder", { universe, existingPrimitives: [] }, counters);
    expect(box.name).toBe("Box 001");
    expect(cyl.name).toBe("Cylinder 001");
  });

  it("has correct initial flags", () => {
    const universe = makeUniverse([1e-6, 1e-6, 1e-6]);
    const node = createDefaultPrimitive("cylinder", { universe, existingPrimitives: [] }, freshCounters());
    expect(node.enabled).toBe(true);
    expect(node.visible).toBe(true);
    expect(node.locked).toBe(false);
    expect(node.kind).toBe("primitive");
  });
});
