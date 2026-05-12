/**
 * @module lib/profiles/frontendRuntimeProfiles
 *
 * Centralised runtime profiles that replace magic constants scattered
 * across viewport, chart, and transport components.
 *
 * See: P6 — Frontend hardening in fullmag-fem-regression-p6-frontend-hardening.mdx
 */

// ── Viewport visual profile ─────────────────────────────────────

export interface ViewportVisualProfile {
  /** Minimum opacity for dimmed magnetic parts (0-255). */
  dimmedMinMagnetic: number;
  /** Minimum opacity for dimmed air parts (0-255). */
  dimmedMinAir: number;
  /** Opacity boost when a magnetic part is selected (0-255). */
  selectedLiftMagnetic: number;
  /** Opacity boost when an air part is selected (0-255). */
  selectedLiftAir: number;
  /** Default ghost opacity for air segments (0-1). */
  airGhostOpacity: number;
  /** Default edge layer opacity (0-1). */
  edgeLayerOpacity: number;
  /** Whether arrows are visible by default. */
  defaultArrowVisibility: boolean;
}

export const DEFAULT_VIEWPORT_VISUAL_PROFILE: ViewportVisualProfile = {
  dimmedMinMagnetic: 14,
  dimmedMinAir: 8,
  selectedLiftMagnetic: 96,
  selectedLiftAir: 52,
  airGhostOpacity: 0.15,
  edgeLayerOpacity: 0.4,
  defaultArrowVisibility: false,
};

// ── Chart decimation profile ────────────────────────────────────

export interface ChartDecimationProfile {
  /** Max points rendered before decimation kicks in. */
  maxVisiblePoints: number;
  /** Decimation algorithm. */
  decimationMode: "stride" | "lttb" | "min-max-bucket";
  /** For min-max-bucket: number of buckets. */
  bucketCount: number;
}

export const DEFAULT_CHART_DECIMATION_PROFILE: ChartDecimationProfile = {
  maxVisiblePoints: 2400,
  decimationMode: "min-max-bucket",
  bucketCount: 1200,
};
