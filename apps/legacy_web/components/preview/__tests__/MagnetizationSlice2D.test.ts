import { describe, expect, it } from "vitest";

import {
  buildSlice2DChartOption,
  buildColorbarLabel,
  buildSlice2DChartTopologyKey,
  rasterToHeatmapPoints,
  reconstructSliceArrowGlyphs,
  is2DVectorColorModeSupported,
  resolveHeatmapTooltipValue,
  resolveEffective2DVectorColorMode,
  resolveSlicePlaneAxes,
  styleSliceVectorGlyphs,
} from "../magnetizationSliceUtils";

describe("resolveHeatmapTooltipValue", () => {
  it("accepts direct heatmap tooltip values", () => {
    expect(resolveHeatmapTooltipValue({ value: [3, 4, 0.25] })).toEqual([3, 4, 0.25]);
  });

  it("accepts array wrapped ECharts tooltip params", () => {
    expect(resolveHeatmapTooltipValue([{ value: [1, 2, -0.5] }])).toEqual([1, 2, -0.5]);
  });

  it("ignores stale or empty tooltip params", () => {
    expect(resolveHeatmapTooltipValue(undefined)).toBeNull();
    expect(resolveHeatmapTooltipValue({})).toBeNull();
    expect(resolveHeatmapTooltipValue({ value: [] })).toBeNull();
  });
});

describe("buildSlice2DChartTopologyKey", () => {
  it("ignores field data revisions and only tracks the slice frame", () => {
    expect(buildSlice2DChartTopologyKey("xy", 32, 24)).toBe("xy:32:24:mesh:0:vectors:0");
    expect(buildSlice2DChartTopologyKey("xy", 32, 24)).toBe(
      buildSlice2DChartTopologyKey("xy", 32, 24),
    );
    expect(buildSlice2DChartTopologyKey("xz", 32, 24)).not.toBe(
      buildSlice2DChartTopologyKey("xy", 32, 24),
    );
    expect(buildSlice2DChartTopologyKey("xy", 32, 24, 3)).toBe("xy:32:24:mesh:3:vectors:0");
    expect(buildSlice2DChartTopologyKey("xy", 32, 24, 3)).not.toBe(
      buildSlice2DChartTopologyKey("xy", 32, 24),
    );
    expect(buildSlice2DChartTopologyKey("xy", 32, 24, 0, 5)).toBe("xy:32:24:mesh:0:vectors:5");
    expect(buildSlice2DChartTopologyKey("xy", 32, 24, 3, 0, "mesh-rev:7")).toBe(
      "xy:32:24:mesh:mesh-rev:7:vectors:0",
    );
  });
});

describe("rasterToHeatmapPoints", () => {
  it("maps API raster samples into physical coordinates when bounds are present", () => {
    const points = rasterToHeatmapPoints({
      values: new Float64Array([1, 2, 3, 4]),
      xLen: 2,
      yLen: 2,
      bounds: {
        u_min: -50e-9,
        u_max: 50e-9,
        v_min: -20e-9,
        v_max: 20e-9,
      },
    });
    expect(points).toHaveLength(4);
    expect(points[0]?.[0]).toBeCloseTo(-25e-9);
    expect(points[0]?.[1]).toBeCloseTo(-10e-9);
    expect(points[0]?.[2]).toBe(1);
    expect(points[1]?.[0]).toBeCloseTo(25e-9);
    expect(points[1]?.[1]).toBeCloseTo(-10e-9);
    expect(points[1]?.[2]).toBe(2);
    expect(points[2]?.[0]).toBeCloseTo(-25e-9);
    expect(points[2]?.[1]).toBeCloseTo(10e-9);
    expect(points[2]?.[2]).toBe(3);
    expect(points[3]?.[0]).toBeCloseTo(25e-9);
    expect(points[3]?.[1]).toBeCloseTo(10e-9);
    expect(points[3]?.[2]).toBe(4);
  });
});

describe("slice plane metadata", () => {
  it("resolves physical axes and colorbar identity for the rendered plane", () => {
    expect(resolveSlicePlaneAxes("yz")).toEqual({ u: "y", v: "z" });
    expect(
      buildColorbarLabel({
        quantityLabel: "H_demag",
        component: "z",
        quantityUnit: "A/m",
        quantityComponentCount: 3,
      }),
    ).toBe("H_demag.z [A/m]");
  });

  it("omits the fake component suffix for scalar quantities", () => {
    expect(
      buildColorbarLabel({
        quantityLabel: "e_total",
        component: "magnitude",
        quantityUnit: "J",
        quantityComponentCount: 1,
      }),
    ).toBe("e_total [J]");
  });

  it("builds physical axes and overlay/vector series for API raster charts", () => {
    const option = buildSlice2DChartOption({
      data: [[-25e-9, -10e-9, 1]],
      xLen: 2,
      yLen: 2,
      scale: {
        min: -1,
        max: 1,
        palette: ["#000000", "#ffffff"],
      },
      quantityLabel: "H_demag",
      quantityUnit: "A/m",
      quantityComponentCount: 3,
      component: "z",
      plane: "xy",
      bounds: {
        u_min: -50e-9,
        u_max: 50e-9,
        v_min: -20e-9,
        v_max: 20e-9,
      },
      showQuantity: true,
      meshOverlay: {
        segments: [
          {
            a: [-50e-9, -20e-9],
            b: [50e-9, 20e-9],
          },
        ],
      },
      vectorGlyphs: [
        {
          origin: [0, 0],
          delta: [1, 0],
          magnitude: 1,
          vector: [1, 0],
          stroke: "#38d9ff",
        },
      ],
    });

    expect((option.xAxis as { type: string; min: number; max: number; name: string }).type).toBe("value");
    expect((option.xAxis as { min: number }).min).toBe(-50e-9);
    expect((option.xAxis as { max: number }).max).toBe(50e-9);
    expect((option.yAxis as { min: number }).min).toBe(-20e-9);
    expect((option.yAxis as { max: number }).max).toBe(20e-9);
    expect((option.graphic as Array<{ style: { text: string } }>)[0]?.style.text).toBe("H_demag.z [A/m]");
    const series = option.series as Array<{ id: string; type: string }>;
    expect(series.map((entry) => entry.id)).toEqual([
      "slice-heatmap",
      "slice-mesh-overlay",
      "slice-vector-glyphs",
    ]);
    expect(series[0]?.type).toBe("custom");
  });

  it("keeps category heatmap only for cell-index rasters without physical bounds", () => {
    const option = buildSlice2DChartOption({
      data: [[0, 0, 1]],
      xLen: 2,
      yLen: 2,
      scale: {
        min: 0,
        max: 1,
        palette: ["#000000", "#ffffff"],
      },
      quantityLabel: "m",
      quantityComponentCount: 3,
      component: "z",
      plane: "xy",
      showQuantity: true,
    });

    expect((option.xAxis as { type: string }).type).toBe("category");
    expect((option.yAxis as { type: string }).type).toBe("category");
    expect(((option.series as Array<{ id: string; type: string }>)[0])).toMatchObject({
      id: "slice-heatmap",
      type: "heatmap",
    });
  });

  it("keeps world axes and mesh series in overlay-only mode", () => {
    const option = buildSlice2DChartOption({
      data: [],
      xLen: 2,
      yLen: 2,
      scale: {
        min: 0,
        max: 1,
        palette: ["#000000", "#ffffff"],
      },
      quantityLabel: "m",
      quantityComponentCount: 3,
      component: "magnitude",
      plane: "xy",
      bounds: {
        u_min: -50e-9,
        u_max: 50e-9,
        v_min: -20e-9,
        v_max: 20e-9,
      },
      showQuantity: false,
      meshOverlay: {
        topologyKey: "mesh-rev:7",
        segments: [
          {
            a: [-50e-9, -20e-9],
            b: [50e-9, 20e-9],
          },
        ],
      },
    });

    expect((option.xAxis as { type: string }).type).toBe("value");
    expect((option.yAxis as { type: string }).type).toBe("value");
    expect((option.series as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      "slice-heatmap",
      "slice-mesh-overlay",
    ]);
    expect((option.visualMap as Array<{ show: boolean }>)[0]?.show).toBe(false);
  });
});

describe("reconstructSliceArrowGlyphs", () => {
  it("reconstructs vector origins in physical coordinates from bounds and arrow density", () => {
    const glyphs = reconstructSliceArrowGlyphs({
      arrows: {
        arrowCount: 4,
        values: new Float64Array([
          1, 0,
          0, 1,
          -1, 0,
          0, -1,
        ]),
      },
      scalarValues: new Float64Array(16).fill(1),
      xLen: 4,
      yLen: 4,
      bounds: {
        u_min: 0,
        u_max: 40,
        v_min: 100,
        v_max: 140,
      },
      arrowEvery: 2,
    });

    expect(glyphs).toHaveLength(4);
    expect(glyphs.map((glyph) => glyph.origin)).toEqual([
      [5, 105],
      [25, 105],
      [5, 125],
      [25, 125],
    ]);
    expect(glyphs.every((glyph) => Math.abs(glyph.delta[0]) <= 9 && Math.abs(glyph.delta[1]) <= 9)).toBe(true);
  });

  it("skips NaN scalar pixels without consuming the arrow order", () => {
    const scalarValues = new Float64Array([
      Number.NaN, 1,
      2, 3,
    ]);
    const glyphs = reconstructSliceArrowGlyphs({
      arrows: {
        arrowCount: 3,
        values: new Float64Array([
          10, 0,
          0, 20,
          30, 0,
        ]),
      },
      scalarValues,
      xLen: 2,
      yLen: 2,
      arrowEvery: 1,
    });

    expect(glyphs).toHaveLength(3);
    expect(glyphs.map((glyph) => glyph.origin)).toEqual([
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(glyphs[0]?.magnitude).toBe(10);
    expect(glyphs[1]?.magnitude).toBe(20);
    expect(glyphs[2]?.magnitude).toBe(30);
  });
});

describe("2D vector colors", () => {
  it("only enables component coloring for components that exist in the current plane", () => {
    expect(is2DVectorColorModeSupported("xy", "x")).toBe(true);
    expect(is2DVectorColorModeSupported("xy", "y")).toBe(true);
    expect(is2DVectorColorModeSupported("xy", "z")).toBe(false);
    expect(resolveEffective2DVectorColorMode("xy", "z")).toBe("orientation");
  });

  it("keeps monochrome coloring exact", () => {
    const glyphs = styleSliceVectorGlyphs({
      glyphs: [
        {
          origin: [0, 0],
          delta: [1, 0],
          magnitude: 2,
          vector: [2, 0],
        },
      ],
      plane: "xz",
      colorMode: "monochrome",
      monoColor: "#123456",
    });

    expect(glyphs).toEqual([
      expect.objectContaining({
        stroke: "#123456",
      }),
    ]);
  });

  it("falls back from unsupported component coloring to orientation coloring", () => {
    const glyph = {
      origin: [0, 0] as [number, number],
      delta: [1, 0] as [number, number],
      magnitude: 1,
      vector: [1, 0] as [number, number],
    };
    const unsupported = styleSliceVectorGlyphs({
      glyphs: [glyph],
      plane: "xy",
      colorMode: "z",
      monoColor: "#38d9ff",
    });
    const orientation = styleSliceVectorGlyphs({
      glyphs: [glyph],
      plane: "xy",
      colorMode: "orientation",
      monoColor: "#38d9ff",
    });

    expect(unsupported[0]?.stroke).toBe(orientation[0]?.stroke);
  });

  it("uses a value-dependent ramp for magnitude coloring", () => {
    const glyphs = styleSliceVectorGlyphs({
      glyphs: [
        {
          origin: [0, 0],
          delta: [1, 0],
          magnitude: 1,
          vector: [1, 0],
        },
        {
          origin: [1, 1],
          delta: [1, 0],
          magnitude: 4,
          vector: [4, 0],
        },
      ],
      plane: "xy",
      colorMode: "magnitude",
      monoColor: "#38d9ff",
    });

    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]?.stroke).not.toBe(glyphs[1]?.stroke);
  });
});
