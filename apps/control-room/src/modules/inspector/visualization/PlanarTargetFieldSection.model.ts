import { layerVisible, type PlanarFieldLayer, type PlanarFieldQuantityOption } from "./planarFieldLayers";
import { planarLayerComponentLabel } from "./PlanarFieldLayerList.model";

export function quantityName(quantities: readonly PlanarFieldQuantityOption[], quantityId: string): string {
  return quantities.find((quantity) => quantity.id === quantityId)?.label ?? quantityId;
}

/** One-line answer to "what does this target show in the 2D view?". */
export function planarFieldShownText(
  layer: PlanarFieldLayer | null,
  inherited: PlanarFieldLayer | null,
  quantities: readonly PlanarFieldQuantityOption[],
): string {
  if (layer) {
    const state = layerVisible(layer) ? "Own setting" : "Own setting, hidden";
    return `${state} · ${quantityName(quantities, layer.quantity_id)} · ${planarLayerComponentLabel(layer)}`;
  }
  if (inherited) {
    return `Inherited from All objects · ${quantityName(quantities, inherited.quantity_id)} · ${planarLayerComponentLabel(inherited)}`;
  }
  return "Not drawn in the 2D view";
}
