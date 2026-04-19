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
  decimationMode: "stride",
  bucketCount: 1200,
};

// ── Field transport profile ─────────────────────────────────────

export interface FieldTransportProfile {
  /** Bootstrap cache TTL in ms. */
  bootstrapCacheTtlMs: number;
  /** Bootstrap reconnect TTL in ms. */
  bootstrapReconnectTtlMs: number;
  /** Preferred payload format. */
  preferredPayloadFormat: "json" | "binary";
  /** Preview precision downcast. */
  previewPrecision: "f64" | "f32";
}

export const DEFAULT_FIELD_TRANSPORT_PROFILE: FieldTransportProfile = {
  bootstrapCacheTtlMs: 4000,
  bootstrapReconnectTtlMs: 15000,
  preferredPayloadFormat: "json",
  previewPrecision: "f64",
};

// ── Live polling profile ────────────────────────────────────────

export interface LivePollingProfile {
  /** Base poll interval in ms for running sessions. */
  runningIntervalMs: number;
  /** Poll interval when session is idle / finished. */
  idleIntervalMs: number;
  /** Whether to reduce refresh when the tab is hidden. */
  reduceOnHiddenTab: boolean;
}

export const DEFAULT_LIVE_POLLING_PROFILE: LivePollingProfile = {
  runningIntervalMs: 250,
  idleIntervalMs: 2000,
  reduceOnHiddenTab: true,
};

// ── Composite runtime profiles ──────────────────────────────────

export interface FrontendRuntimeProfiles {
  viewportVisual: ViewportVisualProfile;
  chartDecimation: ChartDecimationProfile;
  fieldTransport: FieldTransportProfile;
  livePolling: LivePollingProfile;
}

export const DEFAULT_FRONTEND_RUNTIME_PROFILES: FrontendRuntimeProfiles = {
  viewportVisual: DEFAULT_VIEWPORT_VISUAL_PROFILE,
  chartDecimation: DEFAULT_CHART_DECIMATION_PROFILE,
  fieldTransport: DEFAULT_FIELD_TRANSPORT_PROFILE,
  livePolling: DEFAULT_LIVE_POLLING_PROFILE,
};
