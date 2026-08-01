/**
 * FullmagChartTokens — resolves design system CSS custom properties at chart
 * mount time and whenever the theme changes. Components and renderers MUST
 * consume these resolved values instead of raw hex literals or hard-coded
 * font strings.
 *
 * Contract:
 * - Call `resolveChartTokens(element)` once per mount and on theme change.
 * - Raw Catppuccin hex may appear ONLY in `src/design/styles/theme.css`.
 * - No polling / timer; the caller must observe `data-theme` attribute changes.
 */

"use client";

export const CHART_COLOR_NAMES = [
  "blue",
  "green",
  "yellow",
  "red",
  "mauve",
  "peach",
  "teal",
  "sky",
  "pink",
  "lavender",
  "flamingo",
  "rosewater",
] as const;

export type ChartColorName = (typeof CHART_COLOR_NAMES)[number];

export interface FullmagChartTokens {
  /** Ordered chart palette — 12 entries, index-stable. */
  palette: readonly string[];
  /** Typography */
  fontFamily: string;
  fontSize: string;
  /** Structural colors */
  bgSurface: string;
  bgPanel: string;
  borderSubtle: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  focusRing: string;
  /** DataZoom filler: first palette color at low opacity, for drag-range highlight */
  accentFill: string;
}

export const DEFAULT_CHART_TOKENS: FullmagChartTokens = {
  palette: Array.from({ length: 12 }, () => "rgba(137, 180, 250, 1)"),
  fontFamily: "system-ui, sans-serif",
  fontSize: "11px",
  bgSurface: "rgba(30, 30, 46, 1)",
  bgPanel: "rgba(24, 24, 37, 1)",
  borderSubtle: "rgba(49, 50, 68, 1)",
  borderStrong: "rgba(88, 91, 112, 1)",
  textPrimary: "rgba(205, 214, 244, 1)",
  textSecondary: "rgba(186, 194, 222, 1)",
  textMuted: "rgba(108, 112, 134, 1)",
  focusRing: "rgba(137, 180, 250, 1)",
  accentFill: "rgba(137, 180, 250, 0.12)",
};

function css(element: Element, name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Converts an rgb/rgba string or hex string resolved from CSS into rgba(r, g, b, alpha)
 * for canvas compatibility (ECharts canvas renderer does not support color-mix).
 */
export function rgbaWithAlpha(colorStr: string, alpha: number): string {
  if (!colorStr) return `rgba(137, 180, 250, ${alpha})`;
  if (colorStr.startsWith("rgb")) {
    const match = colorStr.match(/\d+/g);
    if (match && match.length >= 3) {
      return `rgba(${match[0]}, ${match[1]}, ${match[2]}, ${alpha})`;
    }
  }
  if (colorStr.startsWith("#")) {
    let hex = colorStr.slice(1);
    if (hex.length === 3) {
      hex = hex.split("").map((c) => c + c).join("");
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  return colorStr;
}

/**
 * Resolves `--fm-*` custom properties from the DOM at call time.
 * Must be called in a browser context (after mount).
 */
export function resolveChartTokens(element: Element): FullmagChartTokens {
  const palette = CHART_COLOR_NAMES.map((name) =>
    css(element, `--fm-chart-${name}`, DEFAULT_CHART_TOKENS.palette[0] ?? "rgba(137, 180, 250, 1)"),
  );

  const primaryAccent = palette[0] || css(element, "--fm-accent", DEFAULT_CHART_TOKENS.palette[0] ?? "rgba(137, 180, 250, 1)");

  return {
    palette,
    fontFamily: css(element, "--fm-font-ui", DEFAULT_CHART_TOKENS.fontFamily),
    fontSize: css(element, "--fm-font-size-xs", DEFAULT_CHART_TOKENS.fontSize),
    bgSurface: css(element, "--fm-bg-surface", DEFAULT_CHART_TOKENS.bgSurface),
    bgPanel: css(element, "--fm-bg-panel", DEFAULT_CHART_TOKENS.bgPanel),
    borderSubtle: css(element, "--fm-border-subtle", DEFAULT_CHART_TOKENS.borderSubtle),
    borderStrong: css(element, "--fm-border-strong", DEFAULT_CHART_TOKENS.borderStrong),
    textPrimary: css(element, "--fm-text-primary", DEFAULT_CHART_TOKENS.textPrimary),
    textSecondary: css(element, "--fm-text-secondary", DEFAULT_CHART_TOKENS.textSecondary),
    textMuted: css(element, "--fm-text-muted", DEFAULT_CHART_TOKENS.textMuted),
    focusRing: css(element, "--fm-focus-ring", DEFAULT_CHART_TOKENS.focusRing),
    accentFill: rgbaWithAlpha(primaryAccent, 0.12),
  };
}

/**
 * Returns an ECharts-compatible color palette array from resolved tokens.
 */
export function paletteFromTokens(tokens: FullmagChartTokens): string[] {
  return [...tokens.palette];
}
