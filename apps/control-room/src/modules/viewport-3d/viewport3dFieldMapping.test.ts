import { describe, expect, it, vi } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildSampledScalarColors,
  buildSurfaceFaceScalarColors,
  buildThicknessAverageZScalarColors,
  buildVertexScalarColors,
  buildVertexScalarColorsChunked,
  fieldTransformNeedsChunking,
  resolveScalarRange,
  resolveViewport3DScalarColorBufferKey,
} from "./viewport3dFieldMapping";
import {
  magnitudeColorRgb,
  normalizeViewport3DColorPalette,
} from "./viewport3dVectorColoring";

function vectorField(values: number[], nComp = 3): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [values.length / nComp, 1, 1],
    nComp,
    pointCount: values.length / nComp,
    quantityId: "m",
    valueCount: values.length,
    values: new Float64Array(values),
  };
}

describe("viewport3dFieldMapping", () => {
  it("uses exact object identity when a scalar buffer has no explicit build key", () => {
    const first = {
      colors: new Float32Array(6),
      colorMode: "magnitude",
      quantityId: "m",
      range: { max: 1, min: 0 },
    };
    const second = {
      ...first,
      colors: new Float32Array(6),
    };

    const firstKey = resolveViewport3DScalarColorBufferKey(first);

    expect(resolveViewport3DScalarColorBufferKey(first)).toBe(firstKey);
    expect(resolveViewport3DScalarColorBufferKey(second)).not.toBe(firstKey);
  });

  it("preserves an explicit scalar build key", () => {
    expect(
      resolveViewport3DScalarColorBufferKey({
        buildKey: "scalar-build:exact",
        colors: new Float32Array(3),
        range: { max: 1, min: 0 },
      }),
    ).toBe("scalar-build:exact");
  });

  it("maps vector magnitude to per-vertex scalar colors", () => {
    const result = buildVertexScalarColors(
      vectorField([
        0, 0, 0,
        1, 0, 0,
      ]),
      2,
    );

    expect(result?.range).toEqual({ max: 1, min: 0 });
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(Float32Array.from([...magnitudeColorRgb(0), ...magnitudeColorRgb(1)])),
    );
  });

  it("applies the selected magnitude colormap palette to scalar colors", () => {
    const result = buildVertexScalarColors(
      vectorField([
        0, 0, 0,
        1, 0, 0,
      ]),
      2,
      undefined,
      "magnitude",
      "inferno",
    );

    expect(normalizeViewport3DColorPalette("inferno")).toBe("inferno");
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(
        Float32Array.from([
          ...magnitudeColorRgb(0, "inferno"),
          ...magnitudeColorRgb(1, "inferno"),
        ]),
      ),
    );
    expect(magnitudeColorRgb(0.5, "inferno")).not.toEqual(
      magnitudeColorRgb(0.5, "viridis"),
    );
  });

  it("treats component-only payloads as scalar component textures", () => {
    const result = buildVertexScalarColors(
      vectorField([-2, 0, 4], 1),
      3,
      undefined,
      "y",
      "coolwarm",
      { max: 4, min: -2 },
    );

    expect(result?.colorMode).toBe("y");
    expect(result?.range).toEqual({ max: 4, min: -2 });
    expect(Array.from(result?.scalarValues ?? [])).toEqual([-2, 0, 4]);
    expect(result?.colors).toHaveLength(9);
  });

  it("uses the selected colormap for sampled FDM scalar colors", () => {
    const result = buildSampledScalarColors(
      vectorField([
        0, 0, 0,
        1, 0, 0,
      ]),
      Uint32Array.from([0, 1]),
      "magnitude",
      "coolwarm",
    );

    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(
        Float32Array.from([
          ...magnitudeColorRgb(0, "coolwarm"),
          ...magnitudeColorRgb(1, "coolwarm"),
        ]),
      ),
    );
  });

  it("maps orientation mode through canonical physical XYZ", () => {
    const result = buildVertexScalarColors(
      vectorField([
        1, 0, 0,
        0, 0, 1,
      ]),
      2,
      undefined,
      "orientation",
    );

    expect(Array.from(result?.colors ?? [])).toEqual([
      1, 0, 0,
      1, 1, 1,
    ]);
  });

  it("accepts HSLSPHERE aliases for surface orientation coloring", () => {
    const result = buildVertexScalarColors(
      vectorField([0, 0, 1]),
      1,
      undefined,
      "HSLSPHERE",
    );

    expect(Array.from(result?.colors ?? [])).toEqual([1, 1, 1]);
  });

  it("does not synthesize orientation colors from component-only payloads", async () => {
    const fieldVector = vectorField([0.25, 0.5, 0.75], 1);

    expect(
      buildVertexScalarColors(fieldVector, 3, undefined, "orientation"),
    ).toBeNull();
    expect(
      buildSampledScalarColors(fieldVector, Uint32Array.from([0, 1]), "orientation"),
    ).toBeNull();
    await expect(
      buildVertexScalarColorsChunked(fieldVector, {
        colorMode: "orientation",
        shaderOnly: true,
      }),
    ).resolves.toBeNull();
  });

  it("maps component color modes through the scalar gradient", () => {
    const result = buildVertexScalarColors(
      vectorField([
        -1, 0, 0,
        1, 0, 0,
      ]),
      2,
      undefined,
      "x",
    );

    expect(result?.range).toEqual({ max: 1, min: -1 });
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(
        Float32Array.from([
          ...magnitudeColorRgb(0),
          ...magnitudeColorRgb(1),
        ]),
      ),
    );
  });

  it("maps component color modes through the selected palette", () => {
    const result = buildVertexScalarColors(
      vectorField([
        -1, 0, 0,
        1, 0, 0,
      ]),
      2,
      undefined,
      "x",
      "inferno",
    );

    expect(result?.range).toEqual({ max: 1, min: -1 });
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(
        Float32Array.from([
          ...magnitudeColorRgb(0, "inferno"),
          ...magnitudeColorRgb(1, "inferno"),
        ]),
      ),
    );
  });

  it("records scalar range diagnostics without changing the color range", () => {
    const values = Array.from({ length: 100 }, () => 1);
    values.push(1000);
    const result = buildVertexScalarColors(vectorField(values, 1), 101);

    expect(result?.range).toEqual({ max: 1000, min: 1 });
    expect(result?.rangeDiagnostics).toEqual({
      finiteCount: 101,
      max: 1000,
      mean: (100 + 1000) / 101,
      min: 1,
      nonFiniteCount: 0,
      outlierDominated: true,
      p01: 1,
      p99: 1,
      zeroCount: 0,
    });
  });

  it("counts non-finite scalar values in range diagnostics", () => {
    const result = buildVertexScalarColors(
      vectorField([0, Number.NaN, Number.POSITIVE_INFINITY, 2], 1),
      4,
    );

    expect(result?.range).toEqual({ max: 0, min: 0 });
    expect(result?.rangeDiagnostics).toMatchObject({
      finiteCount: 2,
      max: 2,
      min: 0,
      nonFiniteCount: 2,
      outlierDominated: false,
      p01: 0,
      p99: 0,
      zeroCount: 1,
    });
  });

  it("maps sampled point indices to compact scalar colors", () => {
    const result = buildSampledScalarColors(
      vectorField([
        -1, 0, 0,
        0, 0, 1,
        1, 0, 0,
      ]),
      Uint32Array.from([0, 2]),
      "x",
    );

    expect(result?.range).toEqual({ max: 1, min: -1 });
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(
        Float32Array.from([
          ...magnitudeColorRgb(0),
          ...magnitudeColorRgb(1),
        ]),
      ),
    );
  });

  it("colors each surface face from the average of its boundary node values", () => {
    const result = buildSurfaceFaceScalarColors(
      vectorField([
        0, 0, 0,
        3, 0, 0,
        6, 0, 0,
      ]),
      Uint32Array.from([0, 1, 2]),
      3,
      "x",
    );

    expect(result?.geometryRole).toBe("face_expanded_surface");
    expect(result?.projectionMode).toBe("surface_faces");
    expect(result?.rangeSource).toBe("face_values");
    expect(Array.from(result?.scalarValues ?? [])).toEqual([3, 3, 3]);
    expect(result?.faceCount).toBe(1);
    expect(result?.degradedFaceCount).toBe(0);
  });

  it("maps explicit node-index payloads before surface-face projection", () => {
    const result = buildSurfaceFaceScalarColors(
      {
        ...vectorField([
          9, 0, 0,
          6, 0, 0,
          3, 0, 0,
        ]),
        indexing: "explicit_node_indices",
        nodeIndices: Uint32Array.from([2, 1, 0]),
      },
      Uint32Array.from([0, 1, 2]),
      3,
      "x",
    );

    expect(Array.from(result?.scalarValues ?? [])).toEqual([6, 6, 6]);
  });

  it("degrades surface-face projection when a face node is missing from the field map", () => {
    const result = buildSurfaceFaceScalarColors(
      {
        ...vectorField([
          9, 0, 0,
          6, 0, 0,
        ]),
        indexing: "explicit_node_indices",
        nodeIndices: Uint32Array.from([2, 1]),
      },
      Uint32Array.from([0, 1, 2]),
      3,
      "x",
    );

    expect(result?.degradedFaceCount).toBe(1);
    expect(result?.missingNodeCount).toBe(1);
    expect(Array.from(result?.colors ?? [])).toEqual([
      0.5, 0.5, 0.5,
      0.5, 0.5, 0.5,
      0.5, 0.5, 0.5,
    ]);
  });

  it("maps sampled node-index payloads for surface-face projection", () => {
    const result = buildSurfaceFaceScalarColors(
      {
        ...vectorField([
          0, 0, 0,
          3, 0, 0,
          6, 0, 0,
        ]),
        indexing: "sampled_node_indices",
        nodeIndices: Uint32Array.from([0, 1, 2]),
      },
      Uint32Array.from([0, 1, 2]),
      3,
      "x",
    );

    expect(Array.from(result?.scalarValues ?? [])).toEqual([3, 3, 3]);
  });

  it("maps legacy scoped payloads for surface-face projection", () => {
    const result = buildSurfaceFaceScalarColors(
      vectorField([
        10, 0, 0,
        20, 0, 0,
        30, 0, 0,
      ]),
      Uint32Array.from([3, 4, 5]),
      6,
      "x",
      "viridis",
      undefined,
      Number.POSITIVE_INFINITY,
      Uint32Array.from([3, 4, 5]),
    );

    expect(result?.degradedFaceCount).toBe(0);
    expect(Array.from(result?.scalarValues ?? [])).toEqual([20, 20, 20]);
  });

  it("maps sampled node-index payloads for thickness-average-z projection", () => {
    const result = buildThicknessAverageZScalarColors(
      {
        ...vectorField([
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, -1,
          0, 0, -1,
          0, 0, -1,
        ]),
        indexing: "sampled_node_indices",
        nodeIndices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      },
      Float32Array.from([
        0, 0, 1,
        1, 0, 1,
        0, 1, 1,
        0, 0, -1,
        1, 0, -1,
        0, 1, -1,
      ]),
      Uint32Array.from([0, 1, 2]),
      6,
      "orientation",
    );

    expect(result?.projectionMode).toBe("thickness_average_z");
    expect(result?.degradedFaceCount).toBe(0);
    expect(result?.projectedSamplesPerBinMin).toBe(2);
  });

  it("maps legacy scoped payloads for thickness-average-z projection", () => {
    const result = buildThicknessAverageZScalarColors(
      vectorField([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, -1,
        0, 0, -1,
        0, 0, -1,
      ]),
      Float32Array.from([
        0, 0, 1,
        1, 0, 1,
        0, 1, 1,
        0, 0, -1,
        1, 0, -1,
        0, 1, -1,
      ]),
      Uint32Array.from([3, 4, 5]),
      6,
      "orientation",
      "viridis",
      undefined,
      Number.POSITIVE_INFINITY,
      Uint32Array.from([3, 4, 5, 0, 1, 2]),
    );

    expect(result?.degradedFaceCount).toBe(0);
    expect(result?.projectedSamplesPerBinMin).toBe(2);
  });

  it("does not build large surface-face projection synchronously", () => {
    const nodeCount = 50_001;
    const values = new Float64Array(nodeCount * 3);
    const surfaceIndices = Uint32Array.from([0, 1, 2]);

    expect(
      buildSurfaceFaceScalarColors(
        {
          ...vectorField([]),
          grid: [nodeCount, 1, 1],
          pointCount: nodeCount,
          valueCount: values.length,
          values,
        },
        surfaceIndices,
        nodeCount,
        "orientation",
      ),
    ).toBeNull();
  });

  it("renders low-confidence orientation for near-zero surface-face vectors", () => {
    const result = buildSurfaceFaceScalarColors(
      vectorField([
        0, 0, 0.0005,
        0, 0, 0.0005,
        0, 0, 0.0005,
      ]),
      Uint32Array.from([0, 1, 2]),
      3,
      "orientation",
    );

    expect(result?.lowNormFaceCount).toBe(1);
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(Float32Array.from([
        0.6, 0.6, 0.6,
        0.6, 0.6, 0.6,
        0.6, 0.6, 0.6,
      ])),
    );
  });

  it("projects thickness-average-z face colors from complete world-z columns", () => {
    const result = buildThicknessAverageZScalarColors(
      vectorField([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, -1,
        0, 0, -1,
        0, 0, -1,
      ]),
      Float32Array.from([
        0, 0, 1,
        1, 0, 1,
        0, 1, 1,
        0, 0, -1,
        1, 0, -1,
        0, 1, -1,
      ]),
      Uint32Array.from([0, 1, 2]),
      6,
      "orientation",
    );

    expect(result?.geometryRole).toBe("face_expanded_surface");
    expect(result?.projectionMode).toBe("thickness_average_z");
    expect(result?.projectedBinCount).toBe(3);
    expect(result?.projectedSamplesPerBinMin).toBe(2);
    expect(result?.projectedSamplesPerBinMax).toBe(2);
    expect(result?.projectedSamplesPerBinMean).toBe(2);
    expect(result?.projectionAxis).toBe("z");
    expect(result?.projectionTolerance).toBeGreaterThan(0);
    expect(result?.rangeSource).toBe("projected_values");
    expect(result?.lowNormFaceCount).toBe(1);
    expect(result?.degradedFaceCount).toBe(0);
    expect(Array.from(result?.vectorValues ?? [])).toEqual([
      0, 0, 0,
      0, 0, 0,
      0, 0, 0,
    ]);
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(Float32Array.from([
        0.6, 0.6, 0.6,
        0.6, 0.6, 0.6,
        0.6, 0.6, 0.6,
      ])),
    );
  });

  it("renders low-confidence orientation for near-zero thickness-average-z vectors", () => {
    const result = buildThicknessAverageZScalarColors(
      vectorField([
        0, 0, 0.0005,
        0, 0, 0.0005,
        0, 0, 0.0005,
      ]),
      Float32Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      Uint32Array.from([0, 1, 2]),
      3,
      "orientation",
    );

    expect(result?.lowNormFaceCount).toBe(1);
    expect(Array.from(result?.colors ?? [])).toEqual(
      Array.from(Float32Array.from([
        0.6, 0.6, 0.6,
        0.6, 0.6, 0.6,
        0.6, 0.6, 0.6,
      ])),
    );
  });

  it("degrades thickness-average-z faces with missing projected bins instead of falling back", () => {
    const result = buildThicknessAverageZScalarColors(
      {
        ...vectorField([
          1, 0, 0,
          0, 1, 0,
        ]),
        indexing: "explicit_node_indices",
        nodeIndices: Uint32Array.from([0, 1]),
      },
      Float32Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      Uint32Array.from([0, 1, 2]),
      3,
      "orientation",
    );

    expect(result).not.toBeNull();
    expect(result?.degradedFaceCount).toBe(1);
    expect(result?.missingNodeCount).toBe(1);
    expect(Array.from(result?.colors ?? [])).toEqual([
      0.5, 0.5, 0.5,
      0.5, 0.5, 0.5,
      0.5, 0.5, 0.5,
    ]);
  });

  it("reports degraded thickness-average-z suitability for non-world-z thin-film bounds", () => {
    const result = buildThicknessAverageZScalarColors(
      vectorField([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
      ]),
      Float32Array.from([
        0, 0, 1,
        0.1, 2, 1,
        0, 4, 1,
        0, 0, -1,
        0.1, 2, -1,
        0, 4, -1,
      ]),
      Uint32Array.from([0, 1, 2]),
      6,
      "orientation",
    );

    expect(result?.projectionSuitability).toBe(
      "degraded_non_world_z_thin_film",
    );
  });

  it("reports degraded thickness-average-z suitability when columns lack depth samples", () => {
    const result = buildThicknessAverageZScalarColors(
      vectorField([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
      ]),
      Float32Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      Uint32Array.from([0, 1, 2]),
      3,
      "orientation",
    );

    expect(result?.projectionSuitability).toBe(
      "degraded_insufficient_depth_samples",
    );
  });

  it("does not build large thickness-average-z projection synchronously", () => {
    const nodeCount = 50_001;
    const values = new Float64Array(nodeCount * 3);
    const positions = new Float32Array(nodeCount * 3);

    expect(
      buildThicknessAverageZScalarColors(
        {
          ...vectorField([]),
          grid: [nodeCount, 1, 1],
          pointCount: nodeCount,
          valueCount: values.length,
          values,
        },
        positions,
        Uint32Array.from([0, 1, 2]),
        nodeCount,
        "orientation",
      ),
    ).toBeNull();
  });

  it("handles sampled indices outside field coverage by falling back to neutral color", () => {
    const result = buildSampledScalarColors(
      vectorField([1, 0, 0]),
      Uint32Array.from([0, 1]),
      "orientation",
    );
    expect(result).not.toBeNull();
    expect(Array.from(result?.colors ?? [])).toEqual([
      1, 0, 0,
      0.5, 0.5, 0.5,
    ]);
  });

  it("keeps monochrome mode on the material color", () => {
    expect(
      buildVertexScalarColors(
        vectorField([1, 0, 0]),
        1,
        undefined,
        "monochrome",
      ),
    ).toBeNull();
  });

  it("requires chunking above the synchronous color transform threshold", () => {
    expect(fieldTransformNeedsChunking(50_001)).toBe(true);
    expect(buildVertexScalarColors(vectorField([1, 0, 0]), 1, 0)).toBeNull();
  });

  it("maps prefix partial field coverage while leaving unmatched topology nodes black", () => {
    const result = buildVertexScalarColors(
      vectorField([0, 0, 1]),
      2,
      undefined,
      "orientation",
    );

    expect(Array.from(result?.colors ?? [])).toEqual([
      1, 1, 1,
      0, 0, 0,
    ]);
  });

  it("rejects field with more points than the topology vertex count", () => {
    // fieldVector.pointCount (2) > vertexCount (1): invalid — cannot map.
    expect(buildVertexScalarColors(vectorField([1, 0, 0, 0, 1, 0]), 1)).toBeNull();
  });

  it("builds colors through a chunked cancellable transform", async () => {
    const yieldToMain = vi.fn(async () => undefined);
    const result = await buildVertexScalarColorsChunked(
      vectorField([0, 1, 2], 1),
      { chunkSize: 1, colorMode: "magnitude", yieldToMain },
    );

    expect(resolveScalarRange(vectorField([0, 1, 2], 1))).toEqual({
      max: 2,
      min: 0,
    });
    if (!result) throw new Error("expected chunked scalar color buffer");
    expect(result.colors).toHaveLength(9);
    expect(yieldToMain).toHaveBeenCalledTimes(4);
  });

  it("builds shader-only scalar values through a chunked transform", async () => {
    const result = await buildVertexScalarColorsChunked(
      vectorField([
        1, 0, 0,
        2, 0, 0,
        3, 0, 0,
      ]),
      {
        chunkSize: 1,
        colorMode: "magnitude",
        colorPalette: "inferno",
        shaderOnly: true,
      },
    );

    if (!result) throw new Error("expected chunked shader scalar buffer");
    expect(result.colors).toHaveLength(0);
    expect(Array.from(result.scalarValues ?? [])).toEqual([1, 2, 3]);
    expect(result.colorMode).toBe("magnitude");
    expect(result.colorPalette).toBe("inferno");
  });

  it("builds shader-only scalar values for component-only payloads", async () => {
    const result = await buildVertexScalarColorsChunked(
      vectorField([-3, 2, 5], 1),
      {
        chunkSize: 1,
        colorMode: "y",
        colorPalette: "magma",
        scalarRange: { max: 5, min: -3 },
        shaderOnly: true,
      },
    );

    if (!result) throw new Error("expected chunked shader scalar buffer");
    expect(result.colors).toHaveLength(0);
    expect(Array.from(result.scalarValues ?? [])).toEqual([-3, 2, 5]);
    expect(result.colorMode).toBe("y");
    expect(result.colorPalette).toBe("magma");
    expect(result.range).toEqual({ max: 5, min: -3 });
  });

  it("builds shader-only vector values for chunked orientation colors", async () => {
    const result = await buildVertexScalarColorsChunked(
      vectorField([
        1, 0, 0,
        0, 0, 1,
      ]),
      {
        chunkSize: 1,
        colorMode: "orientation",
        shaderOnly: true,
      },
    );

    if (!result) throw new Error("expected chunked shader vector buffer");
    expect(result.colors).toHaveLength(0);
    expect(result.scalarValues).toBeUndefined();
    expect(Array.from(result.vectorValues ?? [])).toEqual([
      1, 0, 0,
      0, 0, 1,
    ]);
    expect(result.colorMode).toBe("orientation");
  });

  it("aborts stale chunked field transforms", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildVertexScalarColorsChunked(vectorField([0, 1, 2], 1), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
