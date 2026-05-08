export type ViewportBridgeMode = "3D" | "2D" | "Mesh" | "Analyze";

export interface ViewportBridgeActivityInput {
  active: boolean;
  viewportMode: ViewportBridgeMode;
  showArrows: boolean;
  showQuantity: boolean;
  showMagneticTexture: boolean;
  selectedQuantity: string | null;
  sliceApiFeatureEnabled: boolean;
  sliceTopologyReady: boolean;
}

export interface ViewportBridgeActivity {
  data3DActive: boolean;
  glyphVectorDataNeeded: boolean;
  shaderFieldDataNeeded: boolean;
  slice2DActive: boolean;
}

export function resolveViewportBridgeActivity({
  active,
  viewportMode,
  showArrows,
  showQuantity,
  showMagneticTexture,
  selectedQuantity,
  sliceApiFeatureEnabled,
  sliceTopologyReady,
}: ViewportBridgeActivityInput): ViewportBridgeActivity {
  const data3DActive = active && (viewportMode === "3D" || viewportMode === "Mesh");
  const slice2DActive = active && viewportMode === "2D" && sliceApiFeatureEnabled && sliceTopologyReady;
  return {
    data3DActive,
    glyphVectorDataNeeded: data3DActive && showArrows,
    shaderFieldDataNeeded:
      data3DActive &&
      (showArrows || showQuantity || (showMagneticTexture && selectedQuantity === "m")),
    slice2DActive,
  };
}
