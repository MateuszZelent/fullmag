/**
 * features/visualization — Viewport visualization state management
 *
 * Public API for the visualization domain store.
 */
export {
  useVisualizationStore,
  DEFAULT_CORE as DEFAULT_VISUALIZATION_CORE,
  type ViewportVizCore,
  type VisualizationStoreState,
  // Selectors
  selectMeshRenderMode,
  selectMeshOpacity,
  selectClipEnabled,
  selectClipAxis,
  selectClipPos,
  selectClipFlip,
  selectMeshShowArrows,
  selectFemArrowColorMode,
  selectFemArrowAlpha,
  selectFemArrowLengthScale,
  selectFemArrowThickness,
  selectFemArrowMonoColor,
  selectFemVectorGlyphBudget,
  selectFemVectorDomainFilter,
  selectFemFerromagnetVisibilityMode,
  selectFemViewportLayers,
  selectAirMeshVisible,
  selectAirMeshOpacity,
  selectFemTextureDownsampleCells,
  selectViewportLegendVisible,
  selectViewportAxesScope,
  selectUniverseWireframeVisible,
  selectFdmVisualizationSettings,
  selectVisualizationProjectPresets,
  selectVisualizationLocalPresets,
  selectActiveVisualizationPresetRef,
} from "./store/useVisualizationStore";
