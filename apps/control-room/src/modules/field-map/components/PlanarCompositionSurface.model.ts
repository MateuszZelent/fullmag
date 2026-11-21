import { type PlanarFieldOverlay } from "../model/planarFieldComposition";
import { effectivePass, layerVisible, type PlanarLayerPass, type PlanarLayerState } from "@/modules/inspector/public";

const DRAWN_PASSES: readonly PlanarLayerPass[] = ["raster", "vectors", "points", "contours", "streamlines"];

export type LayerPasses = Readonly<Record<PlanarLayerPass, boolean>>;

/** Passes a layer draws: view mask AND layer flag; a hidden layer draws nothing. */
export function planarLayerPasses(profile: PlanarFieldOverlay, viewMasks: PlanarLayerState): LayerPasses {
  const on = (pass: PlanarLayerPass) => effectivePass(profile, viewMasks, pass) === "on";
  return {
    raster: on("raster"), vectors: on("vectors"), points: on("points"),
    mesh: on("mesh"), contours: on("contours"), streamlines: on("streamlines"),
  };
}

/**
 * Layers that take part in the composite, bottom first: the list is drawn from
 * its end to its start so the first layer is on top. Hidden layers and layers
 * without a drawn pass are left out and therefore request no data.
 */
export function planarCompositionLayers(
  profiles: readonly PlanarFieldOverlay[],
  viewMasks: PlanarLayerState,
): { profile: PlanarFieldOverlay; passes: LayerPasses }[] {
  const drawn: { profile: PlanarFieldOverlay; passes: LayerPasses }[] = [];
  for (let index = profiles.length - 1; index >= 0; index -= 1) {
    const profile = profiles[index]!;
    if (!layerVisible(profile)) continue;
    const passes = planarLayerPasses(profile, viewMasks);
    if (DRAWN_PASSES.some((pass) => passes[pass])) drawn.push({ profile, passes });
  }
  return drawn;
}
