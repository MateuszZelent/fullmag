export function shouldRenderViewportWebglCanvas(args: {
  hidden: boolean;
  hostReady: boolean;
  bareCanvas: boolean;
}): boolean {
  if (args.bareCanvas) {
    return true;
  }
  return args.hostReady;
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
