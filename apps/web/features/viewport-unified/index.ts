/**
 * Viewport-unified barrel export.
 */

// Model
export type {
  UnifiedRenderState,
  UnifiedViewportModel,
} from "./model/unifiedViewportTypes";
export { DEFAULT_UNIFIED_RENDER_STATE } from "./model/unifiedViewportTypes";

// Hooks
export { useUnifiedViewport } from "./hooks/useUnifiedViewport";
export type { AvailableControls } from "./hooks/useUnifiedViewport";
export { useUnifiedDisplayControls } from "./hooks/useUnifiedDisplayControls";

// Components
export { CapabilityPanel } from "./components/CapabilityPanel";
export { UnifiedViewportBar } from "./components/UnifiedViewportBar";

// Registry
export { UNIFIED_VIEWPORT_3D } from "./registry/unifiedViewEntry";
