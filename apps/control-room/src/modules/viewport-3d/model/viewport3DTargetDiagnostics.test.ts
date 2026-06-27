import { describe, expect, it } from "vitest";

import type { Viewport3DTargetRenderPassModel } from "../viewport3dRenderModel";

import type { Viewport3DDerivedWorkItem } from "./viewport3DDerivedWorkPlan";
import { summarizeViewport3DTargetDiagnostics } from "./viewport3DTargetDiagnostics";

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

function workItem(
  overrides: Partial<Viewport3DDerivedWorkItem> = {},
): Viewport3DDerivedWorkItem {
  return {
    blockedReason: null,
    execution: "render-model-sync",
    inputBufferId: "buffer:part-a",
    inputBytes: 0,
    itemCount: 4,
    lane: "field-color",
    latestWins: true,
    outputKind: "scalar-colors",
    outputBytesEstimate: 48,
    passId: "part-a:surface",
    staleCompatibilityKey: "surface:part-a:x:buffer:part-a:viridis:-1:1:m",
    status: "ready",
    targetId: "part-a",
    workId: "field-color:part-a:surface:x:buffer:part-a",
    ...overrides,
  };
}

describe("viewport3DTargetDiagnostics", () => {
  it("summarizes target requests, buffers, passes, and derived work", () => {
    const summaries = summarizeViewport3DTargetDiagnostics({
      derivedWorkItems: [
        workItem(),
        workItem({
          execution: "runtime-worker",
          lane: "vector-glyph",
          outputKind: "vector-glyphs",
          passId: "part-a:vector-glyph",
          workId: "vector-glyph:part-a:field-1:mesh-1",
        }),
        workItem({
          execution: "runtime-worker",
          lane: "vector-glyph",
          outputKind: "vector-segments",
          passId: "part-a:vector-glyph",
          workId: "vector-segments:part-a:field-1:mesh-1",
        }),
      ],
      targetPasses: new Map([["part-a", targetPass()]]),
    });

    expect(summaries).toEqual([
      {
        buffers: [
          "buffer:part-a full-vector-complete quantity=m component=full scope=part:part-a points=4 ncomp=3 indexing=unknown nodeIndices=none topologyHash=none sampled=false state=target-buffer",
        ],
        degradation: [],
        demand: "surface:x vector-glyph",
        derivedWork: [
          "field-color:scalar-colors:ready:render-model-sync:part-a:surface items=4 input=0B output=48B",
          "vector-glyph:vector-glyphs:ready:runtime-worker:part-a:vector-glyph items=4 input=0B output=48B",
          "vector-glyph:vector-segments:ready:runtime-worker:part-a:vector-glyph items=4 input=0B output=48B",
        ],
        passes: ["surface", "vector-glyph"],
        requests: [
          "quantity=m&component=full&scope_kind=part&scope_id=part-a",
        ],
        retained: [],
        targetId: "part-a",
      },
    ]);
  });

  it("explains blocked target work and pass degradation reasons", () => {
    const summaries = summarizeViewport3DTargetDiagnostics({
      derivedWorkItems: [
        workItem({
          blockedReason: "sampled-buffer-not-surface-capable",
          execution: "blocked",
          inputBufferId: "buffer:sampled",
          status: "blocked",
        }),
        workItem({
          blockedReason: "scalar-buffer-not-vector-capable",
          execution: "blocked",
          inputBufferId: "buffer:sampled",
          lane: "vector-glyph",
          outputKind: "vector-glyphs",
          passId: "part-a:vector-glyph",
          status: "blocked",
          workId: "vector-glyph:part-a:blocked",
        }),
        workItem({
          blockedReason: "scalar-buffer-not-vector-capable",
          execution: "blocked",
          inputBufferId: "buffer:sampled",
          lane: "vector-glyph",
          outputKind: "vector-segments",
          passId: "part-a:vector-glyph",
          status: "blocked",
          workId: "vector-segments:part-a:blocked",
        }),
      ],
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

    expect(summaries[0]?.degradation).toEqual([
      "surface:sampled-buffer-not-surface-capable",
      "surface-rejected buffer=buffer:sampled capability=full-vector-sampled reason=sampled-buffer-not-surface-capable",
      "vector-glyph:scalar-buffer-not-vector-capable",
      "vector-glyph-rejected buffer=buffer:sampled capability=full-vector-sampled reason=scalar-buffer-not-vector-capable",
      "field-color:sampled-buffer-not-surface-capable",
    ]);
    expect(summaries[0]?.derivedWork).toEqual([
      "field-color:scalar-colors:blocked:blocked:part-a:surface items=4 input=0B output=48B",
      "vector-glyph:vector-glyphs:blocked:blocked:part-a:vector-glyph items=4 input=0B output=48B",
      "vector-glyph:vector-segments:blocked:blocked:part-a:vector-glyph items=4 input=0B output=48B",
    ]);
  });

  it("reports outlier-dominated scalar ranges without hiding surface colors", () => {
    const summaries = summarizeViewport3DTargetDiagnostics({
      derivedWorkItems: [],
      targetPasses: new Map([
        [
          "part-a",
          targetPass({
            surface: {
              degradation: null,
              passId: "part-a:surface",
              scalarColorMode: "x",
              scalarColors: {
                colors: new Float32Array(12),
                colorMode: "x",
                colorPalette: "viridis",
                quantityId: "h_ex",
                range: { max: 1000, min: 1 },
                rangeDiagnostics: {
                  finiteCount: 101,
                  max: 1000,
                  mean: 10.891089108910892,
                  min: 1,
                  nonFiniteCount: 0,
                  outlierDominated: true,
                  p01: 1,
                  p99: 1,
                  zeroCount: 0,
                },
                targetRevision: "field=field-1",
                topologyRevision: "mesh-1",
              },
            },
          }),
        ],
      ]),
    });

    expect(summaries[0]?.degradation).toEqual([
      "surface:range-outlier-dominated min=1 max=1000 p01=1 p99=1 finite=101 nonFinite=0 zero=0",
    ]);
    expect(summaries[0]?.passes).toEqual(["surface", "vector-glyph"]);
  });

  it("reports stale-compatible retained surface and vector outputs", () => {
    const summaries = summarizeViewport3DTargetDiagnostics({
      derivedWorkItems: [],
      targetPasses: new Map([
        [
          "part-a",
          targetPass({
            fieldBuffer: {
              bufferId: "buffer:part-a:fresh",
              capability: "full-vector-complete",
              component: "full",
              componentCount: 3,
              consumers: ["part-a:surface", "part-a:vector-glyph"],
              fieldRevision: "field-2",
              pointCount: 4,
              quantityId: "m",
              requestId:
                "quantity=m&component=full&scope_kind=part&scope_id=part-a",
              sampled: false,
              scopeId: "part-a",
              scopeKind: "part",
              topologyRevision: "mesh-1",
              values: new Float64Array(12),
              vectorComponentCount: 3,
            },
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
          }),
        ],
      ]),
    });

    expect(summaries[0]?.retained).toEqual([
      "surface stale-compatible current=field-2 retained=field=field-1",
      "vector-glyph stale-compatible current=field-2 retained=field-1",
    ]);
  });
});
