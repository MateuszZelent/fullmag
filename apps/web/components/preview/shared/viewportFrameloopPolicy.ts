export type ViewportFrameloopMode = "always" | "demand" | "never";
export type ViewportRenderMode = "always" | "demand" | "paused";

export function resolveViewportFrameloop(args: {
  hidden: boolean;
  renderMode?: ViewportRenderMode | null;
  forcedFrameloopMode?: ViewportFrameloopMode | null;
}): ViewportFrameloopMode {
  const renderMode = args.renderMode ?? "demand";
  if (args.hidden || renderMode === "paused") {
    return "never";
  }
  if (args.forcedFrameloopMode === "always" || renderMode === "always") {
    return "always";
  }
  if (args.forcedFrameloopMode === "never") {
    return "never";
  }
  return "demand";
}
