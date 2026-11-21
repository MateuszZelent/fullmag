import { type PlanarFieldLayer } from "./planarFieldLayers";
import { isDirectionColormap } from "@/shared/visualization/directionColor";

/** Short component name of a layer row; direction colouring names the direction. */
export function planarLayerComponentLabel(layer: PlanarFieldLayer): string {
  return isDirectionColormap(layer.colormap) ? "direction" : String(layer.component).replaceAll("_", " ");
}

export function planarLayerRowLabel(layer: PlanarFieldLayer, targetLabel: string): string {
  return `${targetLabel} · ${layer.quantity_id} · ${planarLayerComponentLabel(layer)}`;
}
