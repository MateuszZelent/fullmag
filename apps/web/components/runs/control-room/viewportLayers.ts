import type { FemViewportLayerState } from "@/features/viewport-unified/model/unifiedViewportTypes";
import type { FemColorField } from "../../preview/FemMeshView3D";

export interface FemLayerRenderState<TOverlay> {
  objectOverlays: TOverlay[];
  meshOpacity: number;
  colorField: FemColorField;
  showArrows: boolean;
}

export function deriveFemLayerRenderState<TOverlay>(args: {
  layers: FemViewportLayerState;
  objectOverlays: TOverlay[];
  meshOpacity: number;
  colorField: FemColorField;
  showArrows: boolean;
}): FemLayerRenderState<TOverlay> {
  const { layers, objectOverlays, meshOpacity, colorField, showArrows } = args;
  return {
    objectOverlays: layers.showPrimitives ? objectOverlays : [],
    meshOpacity: layers.showMesh ? meshOpacity : 0,
    colorField: layers.showQuantity ? colorField : "none",
    showArrows,
  };
}
