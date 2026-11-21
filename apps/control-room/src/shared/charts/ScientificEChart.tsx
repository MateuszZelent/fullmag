"use client";

import type { ECharts, EChartsOption } from "echarts";
import { useEffect, useRef, type JSX } from "react";

import { cn } from "@/shared/utils/className";

/**
 * Computes finite extrema in a single O(N) indexed loop without spreading the
 * array into `Math.min`/`Math.max` (which throws `RangeError: Maximum call
 * stack size exceeded` in V8 for spectra with >10^5 samples).
 */
export function minMaxFinite(
  values: ArrayLike<number>,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let found = false;

  for (let index = 0; index < values.length; index += 1) {
    const sample = values[index];
    if (sample === undefined || !Number.isFinite(sample)) continue;
    if (sample < min) min = sample;
    if (sample > max) max = sample;
    found = true;
  }

  return found ? { min, max } : null;
}

export interface ResolvedChartThemePalette {
  theme: "dark" | "light";
  fontFamily: string;
  monoFontFamily: string;
  symbolFontFamily: string;
  fontSize: number;
  background: string;
  panelBackground: string;
  fieldBackground: string;
  tooltipBackground: string;
  borderControl: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentText: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  live: string;
  axisX: string;
  axisY: string;
  axisZ: string;
  series: readonly string[];
}

const DARK_FALLBACK_PALETTE: ResolvedChartThemePalette = {
  theme: "dark",
  fontFamily: '"Inter", system-ui, sans-serif',
  monoFontFamily: '"JetBrains Mono", ui-monospace, monospace',
  symbolFontFamily: '"STIX Two Text", serif',
  fontSize: 12,
  background: "rgb(13 13 22)",
  panelBackground: "rgb(22 22 34)",
  fieldBackground: "rgb(17 17 27 / 0.55)",
  tooltipBackground: "rgb(30 30 46 / 0.84)",
  borderControl: "rgb(115 119 143)",
  borderSubtle: "rgb(205 214 244 / 0.12)",
  textPrimary: "rgb(205 214 244)",
  textSecondary: "rgb(186 194 222)",
  textMuted: "rgb(166 173 200)",
  accent: "rgb(137 180 250)",
  accentText: "rgb(137 180 250)",
  success: "rgb(166 227 161)",
  warning: "rgb(249 226 175)",
  danger: "rgb(243 139 168)",
  info: "rgb(137 220 235)",
  live: "rgb(148 226 213)",
  axisX: "rgb(243 139 168)",
  axisY: "rgb(166 227 161)",
  axisZ: "rgb(137 180 250)",
  series: [
    "rgb(137 180 250)",
    "rgb(148 226 213)",
    "rgb(166 227 161)",
    "rgb(250 179 135)",
    "rgb(203 166 247)",
    "rgb(243 139 168)",
    "rgb(249 226 175)",
    "rgb(137 220 235)",
  ],
};

const LIGHT_FALLBACK_PALETTE: ResolvedChartThemePalette = {
  theme: "light",
  fontFamily: '"Inter", system-ui, sans-serif',
  monoFontFamily: '"JetBrains Mono", ui-monospace, monospace',
  symbolFontFamily: '"STIX Two Text", serif',
  fontSize: 12,
  background: "rgb(233 236 243)",
  panelBackground: "rgb(245 246 250)",
  fieldBackground: "rgb(76 79 105 / 0.065)",
  tooltipBackground: "rgb(255 255 255 / 0.86)",
  borderControl: "rgb(118 121 141)",
  borderSubtle: "rgb(76 79 105 / 0.14)",
  textPrimary: "rgb(76 79 105)",
  textSecondary: "rgb(82 85 112)",
  textMuted: "rgb(88 92 113)",
  accent: "rgb(30 102 245)",
  accentText: "rgb(4 78 224)",
  success: "rgb(52 134 34)",
  warning: "rgb(168 104 8)",
  danger: "rgb(210 15 57)",
  info: "rgb(2 132 199)",
  live: "rgb(20 130 137)",
  axisX: "rgb(180 8 45)",
  axisY: "rgb(37 107 21)",
  axisZ: "rgb(4 78 224)",
  series: [
    "rgb(30 102 245)",
    "rgb(20 130 137)",
    "rgb(52 134 34)",
    "rgb(212 77 0)",
    "rgb(136 57 239)",
    "rgb(210 15 57)",
    "rgb(168 104 8)",
    "rgb(2 132 199)",
  ],
};

const SERIES_TOKEN_NAMES = [
  "--fm-chart-blue",
  "--fm-chart-teal",
  "--fm-chart-green",
  "--fm-chart-peach",
  "--fm-chart-mauve",
  "--fm-chart-red",
  "--fm-chart-yellow",
  "--fm-chart-sky",
] as const;

function readActiveTheme(rootElement?: Element | null): "dark" | "light" {
  const docElement = rootElement?.ownerDocument?.documentElement ??
    (typeof document !== "undefined" ? document.documentElement : null);
  const scoped =
    rootElement && typeof rootElement.closest === "function"
      ? rootElement.closest("[data-theme]")?.getAttribute("data-theme")
      : null;
  const datasetTheme =
    docElement && "dataset" in docElement
      ? (docElement as HTMLElement).dataset?.theme
      : null;
  const attrTheme = scoped ?? datasetTheme ?? docElement?.getAttribute("data-theme");
  return attrTheme === "light" ? "light" : "dark";
}

function readToken(
  styles: CSSStyleDeclaration | null,
  tokenName: string,
  fallback: string,
): string {
  const value = styles?.getPropertyValue(tokenName)?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function resolveScientificChartPalette(
  rootElement?: Element | null,
): ResolvedChartThemePalette {
  const theme = readActiveTheme(rootElement);
  const fallback = theme === "light" ? LIGHT_FALLBACK_PALETTE : DARK_FALLBACK_PALETTE;
  const target =
    rootElement?.ownerDocument?.documentElement ??
    (typeof document !== "undefined" ? document.documentElement : null);

  const styles =
    target && typeof getComputedStyle === "function"
      ? getComputedStyle(target)
      : null;

  const parsedFontSize = Number.parseFloat(
    readToken(styles, "--fm-text-xs", String(fallback.fontSize)),
  );
  const fontSize =
    Number.isFinite(parsedFontSize) && parsedFontSize >= 12
      ? parsedFontSize
      : 12;

  return {
    theme,
    fontFamily: readToken(styles, "--fm-font-ui", fallback.fontFamily),
    monoFontFamily: readToken(styles, "--fm-font-mono", fallback.monoFontFamily),
    symbolFontFamily: readToken(styles, "--fm-font-symbol", fallback.symbolFontFamily),
    fontSize,
    background: readToken(styles, "--fm-bg-app", fallback.background),
    panelBackground: readToken(styles, "--fm-bg-panel", fallback.panelBackground),
    fieldBackground: readToken(styles, "--fm-field-bg", fallback.fieldBackground),
    tooltipBackground: readToken(styles, "--fm-glass-strong", fallback.tooltipBackground),
    borderControl: readToken(styles, "--fm-border-control", fallback.borderControl),
    borderSubtle: readToken(styles, "--fm-border-subtle", fallback.borderSubtle),
    textPrimary: readToken(styles, "--fm-text-primary", fallback.textPrimary),
    textSecondary: readToken(styles, "--fm-text-secondary", fallback.textSecondary),
    textMuted: readToken(styles, "--fm-text-muted", fallback.textMuted),
    accent: readToken(styles, "--fm-accent", fallback.accent),
    accentText: readToken(styles, "--fm-accent-text", fallback.accentText),
    success: readToken(styles, "--fm-success", fallback.success),
    warning: readToken(styles, "--fm-warning", fallback.warning),
    danger: readToken(styles, "--fm-danger", fallback.danger),
    info: readToken(styles, "--fm-info", fallback.info),
    live: readToken(styles, "--fm-live", fallback.live),
    axisX: readToken(styles, "--fm-axis-x", fallback.axisX),
    axisY: readToken(styles, "--fm-axis-y", fallback.axisY),
    axisZ: readToken(styles, "--fm-axis-z", fallback.axisZ),
    series: SERIES_TOKEN_NAMES.map((tokenName, index) =>
      readToken(styles, tokenName, fallback.series[index] ?? fallback.accent),
    ),
  };
}

export interface ScientificEChartPointSelectParams {
  seriesIndex: number;
  dataIndex: number;
  value: unknown;
}

export interface ScientificEChartProps {
  optionBuilder: (palette: ResolvedChartThemePalette) => EChartsOption;
  height?: number | string;
  ariaLabel: string;
  className?: string;
  emptyMessage?: string;
  onPointSelect?: (params: ScientificEChartPointSelectParams) => void;
}

/**
 * Reusable `<canvas>` ECharts host for scientific inspector charts.
 * Contract:
 * - One ECharts instance per mounted host (no re-init on option or theme updates).
 * - Reactive to `<html data-theme>` via `MutationObserver` and computed `--fm-*` tokens.
 * - Container resizing via `ResizeObserver` coalesced into a single animation frame.
 * - Deterministic `dispose()` on unmount; zero polling timers or HTTP hooks.
 */
export function ScientificEChart({
  ariaLabel,
  className,
  emptyMessage,
  height = 200,
  onPointSelect,
  optionBuilder,
}: ScientificEChartProps): JSX.Element {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ECharts | null>(null);
  const optionBuilderRef = useRef(optionBuilder);
  const onPointSelectRef = useRef(onPointSelect);

  useEffect(() => {
    optionBuilderRef.current = optionBuilder;
  }, [optionBuilder]);

  useEffect(() => {
    onPointSelectRef.current = onPointSelect;
  }, [onPointSelect]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    let cancelled = false;
    let resizeFrameId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;

    const applyCurrentOption = (chart: ECharts) => {
      const palette = resolveScientificChartPalette(host);
      const option = optionBuilderRef.current(palette);
      chart.setOption(option, { notMerge: true, lazyUpdate: true });
    };

    const handleClick = (rawEvent: unknown) => {
      const callback = onPointSelectRef.current;
      if (!callback || typeof rawEvent !== "object" || rawEvent === null) return;
      const event = rawEvent as {
        seriesIndex?: unknown;
        dataIndex?: unknown;
        value?: unknown;
      };
      if (
        typeof event.seriesIndex === "number" &&
        typeof event.dataIndex === "number"
      ) {
        callback({
          seriesIndex: event.seriesIndex,
          dataIndex: event.dataIndex,
          value: event.value,
        });
      }
    };

    void import("echarts").then((echarts) => {
      if (cancelled) return;
      const chart = echarts.init(host, undefined, {
        renderer: "canvas",
      }) as ECharts;
      instanceRef.current = chart;
      chart.on("click", handleClick);
      applyCurrentOption(chart);

      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(() => {
          if (resizeFrameId !== null && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(resizeFrameId);
          }
          if (typeof requestAnimationFrame === "function") {
            resizeFrameId = requestAnimationFrame(() => {
              resizeFrameId = null;
              if (!cancelled) chart.resize();
            });
          } else if (!cancelled) {
            chart.resize();
          }
        });
        resizeObserver.observe(host);
      }

      const rootHtml = host.ownerDocument?.documentElement;
      if (rootHtml && typeof MutationObserver === "function") {
        themeObserver = new MutationObserver(() => {
          if (!cancelled) applyCurrentOption(chart);
        });
        themeObserver.observe(rootHtml, {
          attributeFilter: ["data-theme"],
          attributes: true,
        });
      }
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      if (resizeFrameId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(resizeFrameId);
      }
      const chart = instanceRef.current;
      if (chart) {
        chart.off("click", handleClick);
        chart.dispose();
        instanceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const chart = instanceRef.current;
    const host = canvasHostRef.current;
    if (!chart || !host) return;
    const palette = resolveScientificChartPalette(host);
    chart.setOption(optionBuilder(palette), { notMerge: true, lazyUpdate: true });
  }, [optionBuilder]);

  const resolvedHeight = typeof height === "number" ? `${height}px` : height;

  return (
    <div
      aria-label={ariaLabel}
      className={cn("fm-scientific-echart", className)}
      data-slot="scientific-echart"
      role="img"
      style={{ height: resolvedHeight }}
    >
      <div
        ref={canvasHostRef}
        className="fm-scientific-echart__canvas"
        data-slot="scientific-echart-canvas"
      />
      {emptyMessage ? (
        <div className="fm-scientific-echart__status" role="status">
          {emptyMessage}
        </div>
      ) : null}
    </div>
  );
}
