import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { DIRECTION_COLORMAP, isDirectionColormap } from "@/shared/visualization/directionColor";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;

/** One-click component choices of the 2D toolbar (mumax3 Display panel). */
export type PlanarComponentPreset = "direction" | "x" | "y" | "z" | "magnitude";

export const PLANAR_COMPONENT_PRESETS: readonly {
  label: string;
  shortcut: string;
  value: PlanarComponentPreset;
}[] = [
  { label: "Direction", shortcut: "V", value: "direction" },
  { label: "x", shortcut: "X", value: "x" },
  { label: "y", shortcut: "Y", value: "y" },
  { label: "z", shortcut: "Z", value: "z" },
  { label: "|v|", shortcut: "M", value: "magnitude" },
];

/**
 * Patch for a preset. Direction keeps the scalar magnitude for contours and
 * probes while the raster is coloured by the full vector; Cartesian
 * components use a diverging palette with a symmetric range; magnitude uses a
 * sequential palette with an automatic range. A manual range is preserved.
 */
export function planarComponentPresetPatch(
  preset: PlanarComponentPreset,
  range: PlanarState["range"] | null | undefined,
): { colormap: string; component: PlanarState["component"]; range?: PlanarState["range"] } {
  const manual = range?.mode === "manual";
  if (preset === "direction") {
    return { colormap: DIRECTION_COLORMAP, component: "magnitude" };
  }
  if (preset === "magnitude") {
    return {
      colormap: "viridis",
      component: "magnitude",
      ...(manual ? {} : { range: { max: null, min: null, mode: "auto" } }),
    };
  }
  return {
    colormap: "coolwarm",
    component: preset,
    ...(manual ? {} : { range: { max: null, min: null, mode: "symmetric" } }),
  };
}

/** Preset matching the current profile, or null for components outside the toolbar. */
export function activePlanarComponentPreset(
  planar: Pick<PlanarState, "colormap" | "component">,
): PlanarComponentPreset | null {
  if (isDirectionColormap(planar.colormap)) return "direction";
  if (planar.component === "x" || planar.component === "y" || planar.component === "z") {
    return planar.component;
  }
  return planar.component === "magnitude" ? "magnitude" : null;
}
