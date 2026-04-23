/**
 * Viewport-unified barrel export.
 */

// Transitional model (legacy shim used by current runtime wiring)
export type {
  UnifiedRenderState,
  UnifiedViewportModel,
  Viewport3DCapabilities as LegacyViewport3DCapabilities,
  Viewport3DInteractionMode as LegacyViewport3DInteractionMode,
  Viewport3DToolbarState as LegacyViewport3DToolbarState,
  Viewport3DModel as LegacyViewport3DModel,
} from "./model/unifiedViewportTypes";
export { DEFAULT_UNIFIED_RENDER_STATE } from "./model/unifiedViewportTypes";

// Canonical contracts (v2+v3 unified program)
export type {
  Viewport3DModel,
  Viewport3DSceneModel,
  Viewport3DQuantityModel,
  Viewport3DOverlayState,
  Viewport3DSelectionState,
  Viewport3DCameraState,
  Viewport3DClipState,
  Viewport3DStatusState,
  Viewport3DDebugState,
  Viewport3DAuthoringModel,
  Viewport3DToolbarState,
  Viewport3DCapability,
  Viewport3DCapabilities,
  Viewport3DDiscretization,
  Viewport3DRenderMode,
  Viewport3DInteractionMode,
  Viewport3DControlState,
  Viewport3DFdmModuleState,
  Viewport3DFdmModulePatch,
  Viewport3DFdmQuality,
  Viewport3DFdmRenderMode,
  Viewport3DFdmVoxelColorMode,
  Viewport3DFdmSampling,
  Viewport3DFdmTopoComponent,
} from "./model/viewport3dContracts";
export {
  resolveViewport3DCapabilities,
  toLegacyBooleanCapabilities,
  controlStateFromCapability,
} from "./model/viewport3dCapabilities";
export {
  createViewport3DToolbarState,
  viewport3dToolbarReducer,
} from "./model/viewport3dToolbarReducer";
export { mapRouteFlagsToViewport3DStages } from "./model/viewport3dFlags";
export {
  buildToolbarStateFromLegacy,
  applyToolbarStateToLegacyRenderState,
  buildViewport3DModelFromAdapter,
  mapFdmSettingsToViewport3DState,
  mapViewport3DFdmPatchToLegacySettingsPatch,
} from "./model/viewport3dAdapters";

// Hooks
export { useUnifiedViewport } from "./hooks/useUnifiedViewport";
export { useUnifiedDisplayControls } from "./hooks/useUnifiedDisplayControls";

// Components
export { CapabilityPanel } from "./components/CapabilityPanel";
export { UnifiedViewportBar } from "./components/UnifiedViewportBar";
export { Viewport3DHost } from "./components/Viewport3DHost";

// Registry
export { UNIFIED_VIEWPORT_3D } from "./registry/unifiedViewEntry";
