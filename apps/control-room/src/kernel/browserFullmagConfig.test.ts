import { describe, expect, it } from "vitest";

import {
  performanceDiagnosticsEnabledFromBrowserConfig,
  viewport3DAirboxLayerEnabledFromBrowserConfig,
  viewport3DBoundsLayersEnabledFromBrowserConfig,
  viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig,
  viewport3DClipLayersEnabledFromBrowserConfig,
  viewport3DDimensionFrameEnabledFromBrowserConfig,
  viewport3DDimensionFrameLabelsEnabledFromBrowserConfig,
  viewport3DDimensionFrameLinesEnabledFromBrowserConfig,
  viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig,
  viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig,
  viewport3DEnabledFromBrowserConfig,
  viewport3DFdmCuboidLayerEnabledFromBrowserConfig,
  viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig,
  viewport3DOverlayLayersEnabledFromBrowserConfig,
  viewport3DOrientationHudEnabledFromBrowserConfig,
  viewport3DPostProcessingEnabledFromBrowserConfig,
  viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig,
  viewport3DSceneLayersEnabledFromBrowserConfig,
  viewport3DTopologyMeshLayerEnabledFromBrowserConfig,
} from "./browserFullmagConfig";

describe("browser fullmag config", () => {
  it("keeps viewport 3D enabled unless it is explicitly disabled", () => {
    expect(viewport3DEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DEnabledFromBrowserConfig({ disableViewport3D: false })).toBe(
      true,
    );
    expect(viewport3DEnabledFromBrowserConfig({ disableViewport3D: true })).toBe(
      false,
    );
  });

  it("allows performance diagnostics to be disabled independently from viewport 3D", () => {
    expect(performanceDiagnosticsEnabledFromBrowserConfig()).toBe(true);
    expect(
      performanceDiagnosticsEnabledFromBrowserConfig({
        disablePerformanceDiagnostics: true,
      }),
    ).toBe(false);
  });

  it("allows viewport 3D probes and orientation widgets to be disabled independently", () => {
    expect(viewport3DBoundsLayersEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DClipLayersEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DFdmCuboidLayerEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DDimensionFrameEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DDimensionFrameLabelsEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DDimensionFrameLinesEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig()).toBe(
      true,
    );
    expect(viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig()).toBe(
      true,
    );
    expect(viewport3DAirboxLayerEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig()).toBe(
      true,
    );
    expect(viewport3DOverlayLayersEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DOrientationHudEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DPostProcessingEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DSceneLayersEnabledFromBrowserConfig()).toBe(true);
    expect(viewport3DTopologyMeshLayerEnabledFromBrowserConfig()).toBe(true);
    expect(
      viewport3DBoundsLayersEnabledFromBrowserConfig({
        disableViewport3DBoundsLayers: true,
      }),
    ).toBe(false);
    expect(
      viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig({
        disableViewport3DCanvasLifecycleProbe: true,
      }),
    ).toBe(false);
    expect(
      viewport3DClipLayersEnabledFromBrowserConfig({
        disableViewport3DClipLayers: true,
      }),
    ).toBe(false);
    expect(
      viewport3DFdmCuboidLayerEnabledFromBrowserConfig({
        disableViewport3DFdmCuboidLayer: true,
      }),
    ).toBe(false);
    expect(
      viewport3DDimensionFrameEnabledFromBrowserConfig({
        disableViewport3DDimensionFrame: true,
      }),
    ).toBe(false);
    expect(
      viewport3DDimensionFrameLabelsEnabledFromBrowserConfig({
        disableViewport3DDimensionFrameLabels: true,
      }),
    ).toBe(false);
    expect(
      viewport3DDimensionFrameLinesEnabledFromBrowserConfig({
        disableViewport3DDimensionFrameLines: true,
      }),
    ).toBe(false);
    expect(
      viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig({
        disableViewport3DDimensionFrameMajorLines: true,
      }),
    ).toBe(false);
    expect(
      viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig({
        disableViewport3DDimensionFrameMinorLines: true,
      }),
    ).toBe(false);
    expect(
      viewport3DAirboxLayerEnabledFromBrowserConfig({
        disableViewport3DAirboxLayer: true,
      }),
    ).toBe(false);
    expect(
      viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig({
        disableViewport3DMeshSizeHighlightLayer: true,
      }),
    ).toBe(false);
    expect(
      viewport3DOverlayLayersEnabledFromBrowserConfig({
        disableViewport3DOverlayLayers: true,
      }),
    ).toBe(false);
    expect(
      viewport3DOrientationHudEnabledFromBrowserConfig({
        disableViewport3DOrientationHud: true,
      }),
    ).toBe(false);
    expect(
      viewport3DSceneLayersEnabledFromBrowserConfig({
        disableViewport3DSceneLayers: true,
      }),
    ).toBe(false);
    expect(
      viewport3DPostProcessingEnabledFromBrowserConfig({
        disableViewport3DPostProcessing: true,
      }),
    ).toBe(false);
    expect(
      viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig({
        disableViewport3DPrimitiveObjectLayer: true,
      }),
    ).toBe(false);
    expect(
      viewport3DTopologyMeshLayerEnabledFromBrowserConfig({
        disableViewport3DTopologyMeshLayer: true,
      }),
    ).toBe(false);
  });
});
