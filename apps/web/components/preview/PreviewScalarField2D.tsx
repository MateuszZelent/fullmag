"use client";

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { DIVERGING_PALETTE, SEQUENTIAL_BLUE_PALETTE, POSITIVE_PALETTE } from "../../lib/colorPalettes";
import { ECHARTS_THEME } from "../../lib/echartsTheme";
import { fmtSI } from "../../lib/format";

interface Props {
  data: [number, number, number][];
  grid: [number, number, number];
  quantityLabel: string;
  quantityUnit?: string;
  component: string;
  min: number;
  max: number;
  axisExtent?: {
    x: [number, number];
    y: [number, number];
    unit: string;
  } | null;
}

const NEGATIVE_PALETTE = SEQUENTIAL_BLUE_PALETTE;
const THEME = ECHARTS_THEME;

function getColorScale(min: number, max: number) {
  if (min < 0 && max > 0) {
    const bound = Math.max(Math.abs(min), Math.abs(max));
    return { min: -bound, max: bound, palette: DIVERGING_PALETTE };
  }
  if (max <= 0) return { min, max, palette: NEGATIVE_PALETTE };
  return { min, max, palette: POSITIVE_PALETTE };
}

function formatMagnitude(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000 || abs < 1e-2) return value.toExponential(2);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(2);
}

export default function PreviewScalarField2D({
  data,
  grid,
  quantityLabel,
  quantityUnit,
  component,
  min,
  max,
  axisExtent = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const { xLen, yLen, scale } = useMemo(() => {
    const xLen = Math.max(1, grid[0]);
    const yLen = Math.max(1, grid[1]);
    return {
      xLen,
      yLen,
      scale: getColorScale(min, max),
    };
  }, [grid, max, min]);

  useEffect(() => {
    if (!containerRef.current || !data.length) return;

    if (!chartRef.current || chartRef.current.isDisposed()) {
      chartRef.current = echarts.init(containerRef.current, undefined, {
        renderer: "canvas",
      });
    }

    const chart = chartRef.current;
    const xCategories = Array.from({ length: xLen }, (_, i) => i);
    const yCategories = Array.from({ length: yLen }, (_, i) => i);
    const xAxisName = axisExtent ? `x (${axisExtent.unit})` : "x (preview index)";
    const yAxisName = axisExtent ? `y (${axisExtent.unit})` : "y (preview index)";

    chart.setOption(
      {
        animation: false,
        grid: { left: 56, right: 18, top: 24, bottom: 56, containLabel: true },
        tooltip: {
          position: "top",
          confine: true,
          formatter: (params: Record<string, unknown>) => {
            const value = params.value as number[];
            return [
              `<strong>${quantityLabel}.${component}</strong>`,
              `x: ${formatAxisCoordinate(value[0], xLen, axisExtent?.x ?? null, axisExtent?.unit ?? "m")}`,
              `y: ${formatAxisCoordinate(value[1], yLen, axisExtent?.y ?? null, axisExtent?.unit ?? "m")}`,
              `value: ${formatMagnitude(value[2])}${quantityUnit ? ` ${quantityUnit}` : ""}`,
            ].join("<br/>");
          },
          backgroundColor: THEME.tooltipBg,
          borderColor: THEME.tooltipBorder,
          borderWidth: 1,
          padding: [10, 12],
          textStyle: { color: THEME.tooltipText, fontSize: 12 },
        },
        xAxis: {
          type: "category",
          data: xCategories,
          name: xAxisName,
          nameLocation: "middle",
          nameGap: 28,
          nameTextStyle: { color: THEME.text2, fontWeight: 600 },
          axisLine: { show: true, lineStyle: { color: THEME.border } },
          axisLabel: {
            color: THEME.text2,
            hideOverlap: true,
            formatter: (value: string) =>
              formatAxisCoordinate(Number(value), xLen, axisExtent?.x ?? null, axisExtent?.unit ?? "m"),
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: "category",
          data: yCategories,
          name: yAxisName,
          nameLocation: "middle",
          nameGap: 38,
          nameTextStyle: { color: THEME.text2, fontWeight: 600 },
          axisLine: { show: true, lineStyle: { color: THEME.border } },
          axisLabel: {
            color: THEME.text2,
            hideOverlap: true,
            formatter: (value: string) =>
              formatAxisCoordinate(Number(value), yLen, axisExtent?.y ?? null, axisExtent?.unit ?? "m"),
          },
          splitLine: { show: false },
        },
        visualMap: {
          min: scale.min,
          max: scale.max,
          calculable: false,
          orient: "horizontal",
          left: "center",
          bottom: 8,
          inRange: { color: scale.palette },
          textStyle: { color: THEME.text2 },
        },
        series: [
          {
            type: "heatmap",
            data,
            progressive: 0,
            emphasis: {
              itemStyle: {
                borderColor: "#edf3fb",
                borderWidth: 1,
              },
            },
          },
        ],
      },
      true,
    );

    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
    };
  }, [axisExtent, component, data, quantityLabel, quantityUnit, scale.max, scale.min, scale.palette, xLen, yLen]);

  useEffect(() => {
    return () => {
      if (chartRef.current && !chartRef.current.isDisposed()) {
        chartRef.current.dispose();
      }
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}

function formatAxisCoordinate(
  index: number,
  size: number,
  extent: [number, number] | null,
  unit: string,
): string {
  if (!extent || !Number.isFinite(index)) {
    return Number.isFinite(index) ? index.toFixed(0) : "—";
  }
  const span = extent[1] - extent[0];
  const step = size > 1 ? span / Math.max(1, size - 1) : 0;
  const coordinate = extent[0] + index * step;
  return fmtSI(coordinate, unit);
}
