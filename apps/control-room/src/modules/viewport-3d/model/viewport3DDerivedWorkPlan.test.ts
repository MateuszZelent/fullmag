import { describe, expect, it } from "vitest";

import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";

import type { Viewport3DTargetRenderPassModel } from "../viewport3dRenderModel";

import { planViewport3DDerivedWorkItems } from "./viewport3DDerivedWorkPlan";

function targetPass(
  overrides: Partial<Viewport3DTargetRenderPassModel> = {},
): Viewport3DTargetRenderPassModel {
  return {
    fieldBuffer: {
      bufferId: "buffer:part-a",
      capability: "full-vector-complete",
      component: "full",
      componentCount: 3,
      consumers: ["part-a:surface", "part-a:vector-glyph"],
      fieldRevision: "field-1",
      pointCount: 4,
      quantityId: "m",
      requestId: "quantity=m&component=full&scope_kind=part&scope_id=part-a",
      sampled: false,
      scopeId: "part-a",
      scopeKind: "part",
      topologyRevision: "mesh-1",
      values: new Float64Array(12),
      vectorComponentCount: 3,
    },
    fieldBufferState: "target-buffer",
    surface: {
      degradation: null,
      passId: "part-a:surface",
      scalarColorMode: "x",
      scalarColors: {
        colors: new Float32Array(12),
        colorMode: "x",
        colorPalette: "viridis",
        quantityId: "m",
        range: { max: 1, min: -1 },
        targetRevision: "field=field-1",
        topologyRevision: "mesh-1",
      },
    },
    vectors: {
      buildReference: {
        buildKey: "vector-glyph:part-a:field-1:mesh-1",
        fieldRevision: "field-1",
        groupKey: "vector-glyph:current:domain:m:part:part-a",
        revisionSummary: "topology=mesh-1 field=field-1",
        targetRevision: "field=field-1",
        topologyRevision: "mesh-1",
      },
      degradation: null,
      passId: "part-a:vector-glyph",
      segments: new Float32Array(7),
    },
    ...overrides,
  };
}

describe("viewport3DDerivedWorkPlan", () => {
  it("plans complex phase projection as explicit derived work", () => {
    const complexFieldVector: DecodedComplexFieldVector = {
      componentCount: 3,
      dtype: "complex128",
      grid: [4, 1, 1],
      pointCount: 4,
      quantityId: "m",
      valueCount: 24,
      values: new Float64Array(24),
    };

    const items = planViewport3DDerivedWorkItems({
      complexFieldVector,
      targetPasses: new Map(),
      visualizationPhaseRad: Math.PI / 3,
    });

    expect(items).toContainEqual(
      expect.objectContaining({
        execution: "runtime-worker",
        inputBytes: complexFieldVector.values.byteLength,
        itemCount: 4,
        lane: "field-color",
        outputBytesEstimate: 4 * 3 * Float64Array.BYTES_PER_ELEMENT,
        outputKind: "complex-phase-projection",
        passId: "complex-field:phase-projection",
        status: "ready",
        targetId: "complex-field",
      }),
    );
  });

  it("creates target-scoped scalar color, vector segment, and vector glyph work items", () => {
    const items = planViewport3DDerivedWorkItems({
      targetPasses: new Map([["part-a", targetPass()]]),
    });

    expect(items).toHaveLength(3);
    expect(items.find((item) => item.lane === "field-color")).toMatchObject({
      blockedReason: null,
      inputBufferId: "buffer:part-a",
      outputKind: "scalar-colors",
      passId: "part-a:surface",
      status: "ready",
      targetId: "part-a",
    });
    expect(
      items.find((item) => item.lane === "field-color")
        ?.staleCompatibilityKey,
    ).toContain("viridis");
    expect(
      items.find((item) => item.outputKind === "vector-segments"),
    ).toMatchObject({
      blockedReason: null,
      execution: "runtime-worker",
      inputBufferId: "buffer:part-a",
      inputBytes: 96,
      itemCount: 1,
      lane: "vector-glyph",
      outputBytesEstimate: 28,
      passId: "part-a:vector-glyph",
      status: "ready",
      targetId: "part-a",
    });
    expect(
      items.find((item) => item.outputKind === "vector-glyphs"),
    ).toMatchObject({
      blockedReason: null,
      execution: "runtime-worker",
      inputBufferId: "buffer:part-a",
      inputBytes: 28,
      itemCount: 1,
      outputKind: "vector-glyphs",
      outputBytesEstimate: 28,
      passId: "part-a:vector-glyph",
      status: "ready",
      targetId: "part-a",
      workId: "vector-glyph:part-a:field-1:mesh-1",
    });
  });

  it("plans missing vector segments as worker work before glyph transforms can run", () => {
    const items = planViewport3DDerivedWorkItems({
      targetPasses: new Map([
        [
          "part-a",
          targetPass({
            vectors: {
              buildReference: null,
              degradation: "vector-segments-unavailable",
              passId: "part-a:vector-glyph",
              segments: null,
            },
          }),
        ],
      ]),
    });

    expect(
      items.find((item) => item.outputKind === "vector-segments"),
    ).toMatchObject({
      blockedReason: null,
      execution: "runtime-worker",
      inputBufferId: "buffer:part-a",
      inputBytes: 96,
      itemCount: 4,
      outputBytesEstimate: 112,
      status: "ready",
    });
    expect(
      items.find((item) => item.outputKind === "vector-glyphs"),
    ).toMatchObject({
      blockedReason: "vector-segments-unavailable",
      execution: "blocked",
      inputBufferId: "buffer:part-a",
      status: "blocked",
    });
  });

  it("keeps a pending large surface color build as ready work", () => {
    const items = planViewport3DDerivedWorkItems({
      targetPasses: new Map([
        [
          "part-a",
          targetPass({
            surface: {
              degradation: "surface-colors-unavailable",
              passId: "part-a:surface",
              scalarColorMode: "x",
              scalarColors: null,
            },
            vectors: {
              buildReference: null,
              degradation: null,
              passId: "part-a:vector-glyph",
              segments: null,
            },
          }),
        ],
      ]),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      blockedReason: null,
      inputBytes: 0,
      itemCount: 0,
      lane: "field-color",
      outputBytesEstimate: 0,
      status: "ready",
    });
    expect(items[0]?.staleCompatibilityKey).toContain("range:min:pending");
  });

  it("marks sampled surface buffers and scalar vector buffers as blocked work", () => {
    const items = planViewport3DDerivedWorkItems({
      targetPasses: new Map([
        [
          "part-a",
          targetPass({
            fieldBuffer: {
              bufferId: "buffer:sampled",
              capability: "full-vector-sampled",
              component: "full",
              componentCount: 3,
              consumers: ["part-a:surface", "part-a:vector-glyph"],
              fieldRevision: "field-1",
              pointCount: 4,
              quantityId: "m",
              requestId: "quantity=m&component=full&max_samples=4",
              sampled: true,
              scopeId: "part-a",
              scopeKind: "part",
              topologyRevision: "mesh-1",
              values: new Float64Array(12),
              vectorComponentCount: 3,
            },
            surface: {
              degradation: "sampled-buffer-not-surface-capable",
              passId: "part-a:surface",
              scalarColorMode: "x",
              scalarColors: null,
            },
            vectors: {
              buildReference: null,
              degradation: "scalar-buffer-not-vector-capable",
              passId: "part-a:vector-glyph",
              segments: null,
            },
          }),
        ],
      ]),
    });

    expect(items).toHaveLength(3);
    expect(items.find((item) => item.lane === "field-color")).toMatchObject({
      blockedReason: "sampled-buffer-not-surface-capable",
      status: "blocked",
    });
    expect(
      items.find((item) => item.outputKind === "vector-segments"),
    ).toMatchObject({
      blockedReason: "scalar-buffer-not-vector-capable",
      status: "blocked",
    });
    expect(
      items.find((item) => item.outputKind === "vector-glyphs"),
    ).toMatchObject({
      blockedReason: "scalar-buffer-not-vector-capable",
      status: "blocked",
    });
  });
});
