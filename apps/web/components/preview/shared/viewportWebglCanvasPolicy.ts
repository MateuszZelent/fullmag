export function shouldRenderViewportWebglCanvas({
  hidden,
  hostReady,
  bareCanvas,
}: {
  hidden: boolean;
  hostReady: boolean;
  bareCanvas: boolean;
}): boolean {
  if (hidden) {
    return false;
  }
  if (bareCanvas) {
    return true;
  }
  return hostReady;
}

export function shouldRenderVectorSurfaceCanvas({
  canvasEnabled,
  hostReady,
  viewportVisible,
}: {
  canvasEnabled: boolean;
  hostReady: boolean;
  viewportVisible: boolean;
}): boolean {
  if (!canvasEnabled) {
    return false;
  }
  return shouldRenderViewportWebglCanvas({
    hidden: !viewportVisible,
    hostReady,
    bareCanvas: false,
  });
}
