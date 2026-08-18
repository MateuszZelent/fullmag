import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarRange = NonNullable<Planar["range"]>;

export type PlanarDisplayMode =
  | "surface"
  | "surface+edges"
  | "wireframe"
  | "points"
  | "off";

export const PLANAR_RANGE_MODE_ITEMS = [
  { label: "Auto", value: "auto" },
  { label: "Manual SI", value: "manual" },
  { label: "Symmetric", value: "symmetric" },
] as const satisfies ReadonlyArray<{ label: string; value: PlanarRange["mode"] }>;

export const PLANAR_VECTOR_GLYPH_ITEMS = [
  { label: "Quiver", value: "quiver" },
] as const;

export const PLANAR_VECTOR_LENGTH_MODE_ITEMS = [
  { label: "Uniform", value: "uniform" },
  { label: "Magnitude", value: "magnitude" },
] as const;

export const PLANAR_VECTOR_COLOR_MODE_ITEMS = [
  { label: "Orientation", value: "orientation" },
  { label: "Monochrome", value: "monochrome" },
  { label: "Magnitude", value: "magnitude" },
] as const;

export const SHARED_VECTOR_COLOR_MODE_ITEMS = PLANAR_VECTOR_COLOR_MODE_ITEMS;

export const PLANAR_QUALITY_ITEMS = [
  { label: "Interactive", value: "interactive" },
  { label: "Export", value: "export" },
] as const satisfies ReadonlyArray<{ label: string; value: Planar["quality"] }>;

/**
 * Maps only the shared quiver intent from the target-visualization profile.
 * 3D geometry-specific attributes deliberately do not cross the boundary.
 */
export function planarVectorStyleFromThreeDimensional(
  settings: Pick<VisualizationTargetSettings, "vectorColorMode" | "vectorLengthScale">,
  current: Planar["vector_style"],
): Planar["vector_style"] | null {
  if (!SHARED_VECTOR_COLOR_MODE_ITEMS.some((item) => item.value === settings.vectorColorMode)) {
    return null;
  }
  return {
    ...current,
    color_mode: settings.vectorColorMode,
    length_mode: "uniform",
    scale: settings.vectorLengthScale,
  };
}

/**
 * Transfers only quiver semantics which both contexts own. The planar
 * resolution remains authoritative except for the explicit shared budget.
 */
export function planarPresentationPatchFromThreeDimensional(
  settings: Pick<
    VisualizationTargetSettings,
    "vectorBudget" | "vectorColorMode" | "vectorLengthScale"
  >,
  resolution: Planar["resolution"],
  vectorStyle: Planar["vector_style"],
): {
  resolution: Planar["resolution"];
  vector_style: Planar["vector_style"];
} | null {
  const nextVectorStyle = planarVectorStyleFromThreeDimensional(settings, vectorStyle);
  if (!nextVectorStyle) return null;
  return {
    resolution: { ...resolution, vector_budget: settings.vectorBudget },
    vector_style: nextVectorStyle,
  };
}

export function planarRangeForMode(
  mode: PlanarRange["mode"],
  current: PlanarRange,
): PlanarRange {
  if (mode !== "manual") return { mode, min: null, max: null };
  const min = current?.mode === "manual" && typeof current.min === "number" ? current.min : -1;
  const max = current?.mode === "manual" && typeof current.max === "number" ? current.max : 1;
  return { mode, min, max };
}

export function planarLayerPatch(
  layers: Planar["layers"],
  key: keyof Planar["layers"],
): { layers: Planar["layers"] } {
  return { layers: { ...layers, [key]: !layers[key] } };
}

export function planarDisplayModePatch(
  mode: PlanarDisplayMode,
  layers: Planar["layers"],
): { layers: Planar["layers"] } {
  const primary = mode === "surface"
    ? { boundaries: false, mesh: false, points: false, raster: true }
    : mode === "surface+edges"
      ? { boundaries: true, mesh: true, points: false, raster: true }
      : mode === "wireframe"
        ? { boundaries: true, mesh: true, points: false, raster: false }
        : mode === "points"
          ? { boundaries: false, mesh: false, points: true, raster: false }
          : { boundaries: false, mesh: false, points: false, raster: false };
  return { layers: { ...layers, ...primary } };
}

export function resolvePlanarDisplayMode(
  layers: Pick<Planar["layers"], "boundaries" | "mesh" | "points" | "raster">,
): PlanarDisplayMode {
  if (layers.points) return "points";
  if (layers.raster && (layers.mesh || layers.boundaries)) return "surface+edges";
  if (layers.raster) return "surface";
  if (layers.mesh || layers.boundaries) return "wireframe";
  return "off";
}

export function planarResolutionPatch(
  resolution: Planar["resolution"],
  next: Partial<Planar["resolution"]>,
): { resolution: Planar["resolution"] } {
  return { resolution: { ...resolution, ...next } };
}

export function planarVectorStylePatch(
  vectorStyle: Planar["vector_style"],
  next: Partial<Planar["vector_style"]>,
): { vector_style: Planar["vector_style"] } {
  return { vector_style: { ...vectorStyle, ...next } };
}

export function planarInteractionPatch(
  interaction: Planar["interaction"],
  next: Partial<Planar["interaction"]>,
): { interaction: Planar["interaction"] } {
  return { interaction: { ...interaction, ...next } };
}
