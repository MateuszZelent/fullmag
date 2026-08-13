import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarRange = NonNullable<Planar["range"]>;

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
): Planar["vector_style"] | null {
  if (!SHARED_VECTOR_COLOR_MODE_ITEMS.some((item) => item.value === settings.vectorColorMode)) {
    return null;
  }
  return {
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
): {
  resolution: Planar["resolution"];
  vector_style: Planar["vector_style"];
} | null {
  const vectorStyle = planarVectorStyleFromThreeDimensional(settings);
  if (!vectorStyle) return null;
  return {
    resolution: { ...resolution, vector_budget: settings.vectorBudget },
    vector_style: vectorStyle,
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
