/**
 * Public viewport integration surface for kernel and sibling modules.
 * Internal render/runtime modules remain private to viewport-3d.
 */

export {
  acquireViewport3DWorkerRuntime,
  getViewport3DWorkerRuntimeSnapshot,
} from "./viewport3dWorkerRuntime";
export { viewport3DFieldUpdateHoldActive } from "./viewport3dFieldUpdateHold";
export { manifestRenderableCarriers } from "./viewport3dDomainAdapter";
export { captureRegisteredViewport3DThumbnail } from "./viewport3dThumbnailRegistry";
export type {
  Viewport3DThumbnail,
  Viewport3DThumbnailColouring,
} from "./viewport3dThumbnail";
export {
  useViewport3DArtifactInspectionPresentation,
  type Viewport3DArtifactInspectionPresentation,
  useViewport3DRenderedScalarRange,
  type Viewport3DRenderedScalarRange,
  type Viewport3DRenderedScalarRangeQuery,
} from "./viewport3dStore";
export {
  useViewport3DAppearance,
  useViewport3DAppearanceDiagnostics,
} from "./viewport3dStore";
export type {
  Viewport3DAppearanceDiagnostics,
  Viewport3DAppearancePreferences,
  Viewport3DAppearanceSection,
  Viewport3DEffectDiagnostic,
} from "./viewport3dAppearancePreferences";
export { VIEW_DIRECTION_COMMANDS } from "./viewport3dViewDirections";

export { useViewport3DInspectorContext, useViewport3DInspectorVisited, setViewport3DInspectorContext } from "./viewport3dInspectorState";

export { Viewport3DInspectorOutlet } from "./components/Viewport3DInspectorOutlet";
