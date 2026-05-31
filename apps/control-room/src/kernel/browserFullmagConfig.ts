export interface BrowserFullmagConfig {
  readonly allowMissingSessionSmoke?: unknown;
  readonly apiBase?: unknown;
  readonly controlRoomApiBase?: unknown;
  readonly disablePerformanceDiagnostics?: unknown;
  readonly disableRealtime?: unknown;
  readonly disableViewport3D?: unknown;
  readonly disableViewport3DBoundsLayers?: unknown;
  readonly disableViewport3DCanvasLifecycleProbe?: unknown;
  readonly disableViewport3DClipLayers?: unknown;
  readonly disableViewport3DFdmCuboidLayer?: unknown;
  readonly disableViewport3DDimensionFrame?: unknown;
  readonly disableViewport3DDimensionFrameLabels?: unknown;
  readonly disableViewport3DDimensionFrameLines?: unknown;
  readonly disableViewport3DDimensionFrameMajorLines?: unknown;
  readonly disableViewport3DDimensionFrameMinorLines?: unknown;
  readonly disableViewport3DAirboxLayer?: unknown;
  readonly disableViewport3DMeshSizeHighlightLayer?: unknown;
  readonly disableViewport3DOverlayLayers?: unknown;
  readonly disableViewport3DOrientationHud?: unknown;
  readonly disableViewport3DPostProcessing?: unknown;
  readonly disableViewport3DPrimitiveObjectLayer?: unknown;
  readonly disableViewport3DSceneLayers?: unknown;
  readonly disableViewport3DTopologyMeshLayer?: unknown;
  readonly enablePerformanceDiagnostics?: unknown;
  readonly enableViewport3DOrbitDebug?: unknown;
  readonly runtimeHttpBase?: unknown;
}

function readBrowserFullmagConfig():
  | BrowserFullmagConfig
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return (window as Window & { __FULLMAG_CONFIG__?: BrowserFullmagConfig })
    .__FULLMAG_CONFIG__;
}

export function viewport3DEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3D !== true;
}

export function performanceDiagnosticsEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  if (config?.disablePerformanceDiagnostics === true) return false;
  return config?.enablePerformanceDiagnostics === true;
}

export function viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DCanvasLifecycleProbe !== true;
}

export function viewport3DBoundsLayersEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DBoundsLayers !== true;
}

export function viewport3DClipLayersEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DClipLayers !== true;
}

export function viewport3DFdmCuboidLayerEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DFdmCuboidLayer !== true;
}

export function viewport3DDimensionFrameEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DDimensionFrame !== true;
}

export function viewport3DDimensionFrameLabelsEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DDimensionFrameLabels !== true;
}

export function viewport3DDimensionFrameLinesEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DDimensionFrameLines !== true;
}

export function viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DDimensionFrameMajorLines !== true;
}

export function viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DDimensionFrameMinorLines !== true;
}

export function viewport3DAirboxLayerEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DAirboxLayer !== true;
}

export function viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DMeshSizeHighlightLayer !== true;
}

export function viewport3DOrientationHudEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DOrientationHud !== true;
}

export function viewport3DOrbitDebugEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.enableViewport3DOrbitDebug === true;
}

export function viewport3DOverlayLayersEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DOverlayLayers !== true;
}

export function viewport3DPostProcessingEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DPostProcessing !== true;
}

export function viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DPrimitiveObjectLayer !== true;
}

export function viewport3DSceneLayersEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DSceneLayers !== true;
}

export function viewport3DTopologyMeshLayerEnabledFromBrowserConfig(
  config: BrowserFullmagConfig | undefined = readBrowserFullmagConfig(),
): boolean {
  return config?.disableViewport3DTopologyMeshLayer !== true;
}
