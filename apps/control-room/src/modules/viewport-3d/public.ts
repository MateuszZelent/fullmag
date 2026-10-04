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
  useViewport3DRenderedScalarRange,
  type Viewport3DRenderedScalarRange,
  type Viewport3DRenderedScalarRangeQuery,
} from "./viewport3dStore";
