import type { FemViewportLayerState } from "@/features/viewport-unified/model/unifiedViewportTypes";
import type { FemColorField } from "@/components/preview/FemMeshView3D";

export interface FemLayerRenderState<TOverlay> {
  objectOverlays: TOverlay[];
  meshOpacity: number;
  magneticColorField: FemColorField;
  airColorField: FemColorField;
  showArrows: boolean;
}

export function deriveFemLayerRenderState<TOverlay>(args: {
  layers: FemViewportLayerState;
  objectOverlays: TOverlay[];
  meshOpacity: number;
  colorField: FemColorField;
  magneticTextureColorField: FemColorField;
  showArrows: boolean;
}): FemLayerRenderState<TOverlay> {
  const { layers, objectOverlays, meshOpacity, colorField, magneticTextureColorField, showArrows } = args;
  return {
    objectOverlays: layers.showPrimitives ? objectOverlays : [],
    meshOpacity: layers.showMesh ? meshOpacity : 0,
    magneticColorField: layers.showQuantity
      ? colorField
      : layers.showMagneticTexture
        ? magneticTextureColorField
        : "none",
    airColorField: layers.showQuantity ? colorField : "none",
    showArrows,
  };
}
