/**
 * Shared color palettes for scientific visualization.
 *
 * Single source of truth for all diverging, sequential, and component
 * color ramps used across 2D heatmaps, 3D views, and slice visualizations.
 */

/* ── Diverging palette (blue-white-red) for signed fields ─────────── */
export const DIVERGING_PALETTE = [
  "#15315f", "#2f6caa", "#90b9df", "#f4f1ed", "#efb09d", "#cf6256", "#7d1d34",
] as const;

/* ── Sequential (blue) palette for unsigned fields ─────────────── */
export const SEQUENTIAL_BLUE_PALETTE = [
  "#f3f7fd", "#cfdef1", "#91b8dd", "#5688bd", "#285b93", "#14365f",
] as const;

/* ── Positive palette (dark-to-bright) for magnitude fields ────── */
export const POSITIVE_PALETTE = [
  "#0a1220", "#143d67", "#1c6d8f", "#24a0a4", "#8ed6ac", "#f1f7bb",
] as const;

/* ── Component diverging colors (for Three.js / WebGL) ─────────── */
export const COMP_NEGATIVE_HEX = "#2f6caa";
export const COMP_NEUTRAL_HEX = "#f4f1ed";
export const COMP_POSITIVE_HEX = "#cf6256";

/* ── Quality metric colors ─────────────────────────────────────── */
export const QUALITY_GOOD_HEX = "#35b779";
export const QUALITY_MID_HEX = "#fde725";
export const QUALITY_BAD_HEX = "#cf6256";
