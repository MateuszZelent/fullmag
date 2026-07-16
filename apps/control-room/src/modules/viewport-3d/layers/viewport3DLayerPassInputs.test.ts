import { describe, expect, it } from "vitest";

import {
  resolveViewport3DTargetSurfaceLayerInput,
  resolveViewport3DTargetLayerRequestedSourceIdentity,
  resolveViewport3DTargetVectorLayerInput,
} from "./viewport3DLayerPassInputs";

describe("viewport3DLayerPassInputs", () => {
  it("keeps requested source identities separate for later visible-adoption receipts", () => {
    const scalarColors = {
      buildKey: "scalar-requested",
      colors: new Float32Array(3),
      range: { max: 1, min: 0 },
    };
    const pass = {
      fieldBuffer: { bufferId: "field-requested" },
      fieldBufferState: "target-buffer" as const,
      surface: { scalarColorMode: "x", scalarColors },
      vectors: {
        buildReference: { buildKey: "vector-requested" },
        segments: new Float32Array(6),
      },
    };

    expect(
      resolveViewport3DTargetLayerRequestedSourceIdentity({
        fieldModel: { targetPasses: new Map([["part:a", pass]]) },
        partId: "part:a",
      }),
    ).toEqual({
      fieldBufferId: "field-requested",
      scalarBufferKey: "scalar-requested",
      vectorBuildKey: "vector-requested",
    });
  });
  it("does not fall back to global surface colors when a target surface pass exists", () => {
    const globalColors = {
      colors: new Float32Array(0),
      colorMode: "x",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
    };

    expect(
      resolveViewport3DTargetSurfaceLayerInput({
        fieldModel: {
          scalarColorsByMode: new Map([["x", globalColors]]),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
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
              },
            ],
          ]),
        },
        partId: "part-a",
        scalarColorMode: "x",
      }).scalarColors,
    ).toBeNull();
  });

  it("keeps legacy part surface colors ahead of global fallback during migration", () => {
    const partColors = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 2, min: -2 },
    };
    const globalColors = {
      colors: new Float32Array(0),
      colorMode: "y",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
    };

    expect(
      resolveViewport3DTargetSurfaceLayerInput({
        fieldModel: {
          scalarColorsByMode: new Map([["y", globalColors]]),
          scalarColorsByPartAndMode: new Map([
            ["part-a", new Map([["y", partColors]])],
          ]),
        },
        partId: "part-a",
        scalarColorMode: "y",
      }).scalarColors,
    ).toBe(partColors);
  });

  it("does not fall back to global surface colors when the target-pass model is authoritative but missing this target", () => {
    const globalColors = {
      colors: new Float32Array(0),
      colorMode: "x",
      colorPalette: "viridis",
      quantityId: "m",
      range: { max: 1, min: -1 },
    };

    expect(
      resolveViewport3DTargetSurfaceLayerInput({
        fieldModel: {
          scalarColorsByMode: new Map([["x", globalColors]]),
          scalarColorsByPartAndMode: new Map(),
          targetPasses: new Map([
            [
              "part-b",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  degradation: null,
                  passId: "part-b:surface",
                  scalarColorMode: "x",
                  scalarColors: globalColors,
                },
                vectors: {
                  buildReference: null,
                  degradation: null,
                  passId: "part-b:vector-glyph",
                  segments: null,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
        scalarColorMode: "x",
      }).scalarColors,
    ).toBeNull();
  });

  it("keeps target vector pass data ahead of legacy vector maps", () => {
    const targetSegments = new Float32Array([1, 2, 3]);
    const legacySegments = new Float32Array([4, 5, 6]);

    expect(
      resolveViewport3DTargetVectorLayerInput({
        fieldModel: {
          partVectorBuilds: new Map(),
          partVectorSegments: new Map([["part-a", legacySegments]]),
          targetPasses: new Map([
            [
              "part-a",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  degradation: null,
                  passId: "part-a:surface",
                  scalarColorMode: null,
                  scalarColors: null,
                },
                vectors: {
                  buildReference: null,
                  degradation: null,
                  passId: "part-a:vector-glyph",
                  segments: targetSegments,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
      }).segments,
    ).toBe(targetSegments);
  });

  it("does not fall back to legacy vector maps when the target-pass model is authoritative but missing this target", () => {
    const legacySegments = new Float32Array([4, 5, 6]);

    expect(
      resolveViewport3DTargetVectorLayerInput({
        fieldModel: {
          partVectorBuilds: new Map(),
          partVectorSegments: new Map([["part-a", legacySegments]]),
          targetPasses: new Map([
            [
              "part-b",
              {
                fieldBuffer: null,
                fieldBufferState: "target-buffer",
                surface: {
                  degradation: null,
                  passId: "part-b:surface",
                  scalarColorMode: null,
                  scalarColors: null,
                },
                vectors: {
                  buildReference: null,
                  degradation: null,
                  passId: "part-b:vector-glyph",
                  segments: null,
                },
              },
            ],
          ]),
        },
        partId: "part-a",
      }),
    ).toEqual({
      buildReference: null,
      segments: null,
    });
  });
});
