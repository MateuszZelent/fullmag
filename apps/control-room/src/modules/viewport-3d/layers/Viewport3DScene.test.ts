import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";

import {
  applyViewport3DPerspectiveCameraPose,
  applyViewport3DOrthographicCameraPose,
  resolveViewport3DProjectionCameraClip,
  shouldApplyViewport3DProjectionCameraClip,
  resolveViewport3DEffectiveCameraState,
  resolveViewport3DOrthographicCameraFrame,
  resolveViewport3DOrthographicZoom,
  resolveNextViewport3DModelLayerStage,
  resolveAuthoredRegionOverlayVisibility,
  resolveViewport3DAirboxFrameState,
  resolveViewport3DModelLayerStageVisibility,
  resolveViewport3DRealizedFdmObjectIds,
  scheduleViewport3DProjectionRenderFrames,
  VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE,
} from "./Viewport3DScene";

function invokeFrameCallback(
  callback: FrameRequestCallback | null,
  time: DOMHighResTimeStamp,
): void {
  if (!callback) {
    throw new Error("Expected requestAnimationFrame callback to be scheduled.");
  }

  callback(time);
}

describe("Viewport3DScene scale helpers", () => {
  it("treats native multilayer grids as realized object geometry", () => {
    expect(
      resolveViewport3DRealizedFdmObjectIds({
        fdmNativeLayerViews: [
          { domain: { objectId: "layer_bottom" } },
          { domain: { objectId: "layer_top" } },
        ] as never,
        fdmTargetViews: [
          { ownerTarget: { id: "object:single_grid", kind: "object" } },
        ] as never,
      }),
    ).toEqual(new Set(["single_grid", "layer_bottom", "layer_top"]));
  });

  it("wires ordinary OrbitControls into the camera registry interaction lifecycle", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const controlsStart = source.indexOf("<OrbitCameraControls");
    const controlsBlock = source.slice(
      controlsStart,
      source.indexOf("/>", controlsStart),
    );

    expect(controlsBlock).toContain(
      "onCameraInteractionStart={onCameraInteractionStart}",
    );
    expect(controlsBlock).toContain(
      "onCameraInteractionEnd={onCameraInteractionEnd}",
    );
  });

  it("passes the requested FDM Airbox wireframe and points into the inactive-cell layer", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const fdmAirboxMeshSettings =");
    expect(source).toContain("settings={fdmAirboxMeshSettings}");
    expect(source).not.toContain("pointsVisible: false,\n        shaderVisible: false,\n        wireframeVisible: false,");
  });

  it("routes outside-support FDM field adoption through its exact carrier", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const airboxPass = source.slice(
      source.indexOf("fdmAirboxPassPlan.needsInactiveCellGeometry"),
      source.indexOf("!fdmLaneActive", source.indexOf("fdmAirboxPassPlan.needsInactiveCellGeometry")),
    );

    expect(airboxPass).toContain("adoptionRegistry={adoptionRegistry}");
    expect(airboxPass).toContain(
      'carrierId="fdm-universe-outside-support"',
    );
  });

  it("invalidates demand rendering before acknowledging changed adoption evidence", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const adoptionFrameHook = source.slice(
      source.indexOf("function useViewport3DRenderAdoptionFrame"),
      source.indexOf("export function Viewport3DScene"),
    );

    expect(adoptionFrameHook).toContain("adoptionRegistry.subscribe");
    expect(adoptionFrameHook).toContain('tracker.recordDirtyFrame("render-adoption")');
    const subscriberStart = adoptionFrameHook.indexOf(
      "adoptionRegistry.subscribe",
    );
    expect(
      adoptionFrameHook.indexOf("invalidate();", subscriberStart),
    ).toBeLessThan(
      adoptionFrameHook.indexOf(
        "onVisualizationFrameCommitted(",
        subscriberStart,
      ),
    );
    expect(adoptionFrameHook).toContain(
      "onVisualizationFrameCommitted(\n          visualizationRevision,\n          airboxFrameState,\n        )",
    );
  });

  it("binds Airbox frame state to the staged multilayer render passes", () => {
    const visibleState = resolveViewport3DAirboxFrameState({
      fdmAirboxInstanceModel: null,
      fdmAirboxPassPlan: {
        hasAnyEffectivePass: false,
        needsExtentOverlay: false,
        needsInactiveCellGeometry: false,
        needsPointGeometry: false,
        needsSurfaceInstances: false,
        needsVectorAnchors: false,
      },
      fdmAirboxVectorSegments: null,
      fdmCuboidLayerEnabled: true,
      fdmLaneActive: true,
      multilayerAirboxView: {
        model: { count: 4 },
        settings: {
          boundsVisible: false,
          pointsVisible: false,
          shaderVisible: false,
          vectorsVisible: true,
          visible: true,
          wireframeVisible: true,
        },
        vectorSegments: new Float32Array(7),
      },
      sceneLayersEnabled: true,
      stageVisibility: resolveViewport3DModelLayerStageVisibility(2),
      vectorLayersEnabled: true,
    });

    expect(visibleState).toEqual({
      airboxVectorsVisible: true,
      airboxWireframeVisible: true,
    });
    expect(
      resolveViewport3DAirboxFrameState({
        fdmAirboxInstanceModel: null,
        fdmAirboxPassPlan: {
          hasAnyEffectivePass: false,
          needsExtentOverlay: false,
          needsInactiveCellGeometry: false,
          needsPointGeometry: false,
          needsSurfaceInstances: false,
          needsVectorAnchors: false,
        },
        fdmAirboxVectorSegments: null,
        fdmCuboidLayerEnabled: true,
        fdmLaneActive: true,
        multilayerAirboxView: {
          model: { count: 4 },
          settings: {
            boundsVisible: false,
            pointsVisible: false,
            shaderVisible: false,
            vectorsVisible: true,
            visible: true,
            wireframeVisible: true,
          },
          vectorSegments: new Float32Array(7),
        },
        sceneLayersEnabled: true,
        stageVisibility: resolveViewport3DModelLayerStageVisibility(1),
        vectorLayersEnabled: true,
      }),
    ).toEqual({
      airboxVectorsVisible: false,
      airboxWireframeVisible: true,
    });
  });

  it("reports disabled Airbox passes when renderer feature gates are closed", () => {
    const baseInput = {
      fdmAirboxInstanceModel: null,
      fdmAirboxPassPlan: {
        hasAnyEffectivePass: false,
        needsExtentOverlay: false,
        needsInactiveCellGeometry: false,
        needsPointGeometry: false,
        needsSurfaceInstances: false,
        needsVectorAnchors: false,
      },
      fdmAirboxVectorSegments: null,
      fdmLaneActive: true,
      multilayerAirboxView: {
        model: { count: 4 },
        settings: {
          boundsVisible: false,
          pointsVisible: false,
          shaderVisible: false,
          vectorsVisible: true,
          visible: true,
          wireframeVisible: true,
        },
        vectorSegments: new Float32Array(7),
      },
      sceneLayersEnabled: true,
      stageVisibility: resolveViewport3DModelLayerStageVisibility(2),
    } as const;

    expect(
      resolveViewport3DAirboxFrameState({
        ...baseInput,
        fdmCuboidLayerEnabled: false,
        vectorLayersEnabled: true,
      }),
    ).toEqual({
      airboxVectorsVisible: false,
      airboxWireframeVisible: false,
    });
    expect(
      resolveViewport3DAirboxFrameState({
        ...baseInput,
        fdmCuboidLayerEnabled: true,
        vectorLayersEnabled: false,
      }),
    ).toEqual({
      airboxVectorsVisible: false,
      airboxWireframeVisible: true,
    });
  });

  it("passes the frame-bound Airbox state from the resource-frame effect", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const resourceFrameEffect = source.slice(
      source.indexOf("// Demand rendering needs an explicit frame"),
      source.indexOf(
        "\n\n  return (",
        source.indexOf("// Demand rendering needs an explicit frame"),
      ),
    );

    expect(resourceFrameEffect).toContain(
      "onVisualizationFrameCommitted(visualizationRevision, airboxFrameState)",
    );
    expect(resourceFrameEffect).toContain("airboxFrameState,");
  });

  it("places the shared glyph-cache provider above the model stack that mounts VectorFieldLayer consumers", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const sceneStart = source.indexOf("export function Viewport3DScene(");
    const providerStart = source.indexOf(
      "<VectorGlyphDerivedBufferCacheProvider",
      sceneStart,
    );
    const modelStackStart = source.indexOf("<Viewport3DModelLayerStack", sceneStart);
    const providerEnd = source.indexOf(
      "</VectorGlyphDerivedBufferCacheProvider>",
      providerStart,
    );

    expect(providerStart).toBeGreaterThan(sceneStart);
    expect(providerStart).toBeLessThan(modelStackStart);
    expect(providerEnd).toBeGreaterThan(modelStackStart);
  });

  it("uses the demand-rendered dimension frame layer instead of Three helper grids", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("DimensionFrameLayer");
    expect(source).not.toContain("<gridHelper");
    expect(source).not.toContain("<axesHelper");
  });

  it("adapts orthographic zoom to micromagnetic dimensions", () => {
    expect(
      resolveViewport3DOrthographicZoom(
        {
          center: [0, 0, 0],
          radius: 5e-8,
          size: [1e-7, 1e-7, 1e-8],
        },
        { height: 600, width: 800 },
      ),
    ).toBeCloseTo(600 / (1e-7 * 1.6));
  });

  it("fits the untouched default camera to an FDM domain", () => {
    const fitted = resolveViewport3DEffectiveCameraState({
      bounds: {
        center: [0, 0, 0],
        radius: 2.58e-7,
        size: [5e-7, 1.25e-7, 3e-9],
      },
      cameraState: {
        position: [2e-6, 1.4e-6, 2e-6],
        target: [0, 0, 0],
        up: [0, 0, 1],
      },
    });

    expect(fitted.position[0]).toBeCloseTo(2.58e-7 * 2.8);
    expect(fitted.position[1]).toBeCloseTo(2.58e-7 * 2.8 * 0.72);
    expect(fitted.position[2]).toBeCloseTo(2.58e-7 * 2.8);
    expect(fitted.target).toEqual([0, 0, 0]);
  });

  it("preserves an explicit user camera instead of refitting it", () => {
    const cameraState = {
      position: [7e-7, 4e-7, 9e-7] as [number, number, number],
      target: [1e-8, -2e-8, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };

    expect(
      resolveViewport3DEffectiveCameraState({
        bounds: {
          center: [0, 0, 0],
          radius: 2.58e-7,
          size: [5e-7, 1.25e-7, 3e-9],
        },
        cameraState,
      }),
    ).toBe(cameraState);
  });

  it("uses a viewport-sized orthographic frustum with micromagnetic zoom", () => {
    const frame = resolveViewport3DOrthographicCameraFrame(
      {
        center: [0, 0, 0],
        radius: 5e-8,
        size: [1e-7, 1e-7, 1e-8],
      },
      { height: 600, width: 800 },
    );

    expect(frame.top - frame.bottom).toBe(600);
    expect(frame.right - frame.left).toBe(800);
    expect(frame.zoom).toBeCloseTo(600 / (1e-7 * 1.6));
  });

  it("lets an explicit orthographic scale control the visible zoom", () => {
    expect(
      resolveViewport3DOrthographicZoom(
        {
          center: [0, 0, 0],
          radius: 5e-8,
          size: [1e-7, 1e-7, 1e-8],
        },
        { height: 600, width: 800 },
        undefined,
        2e-7,
      ),
    ).toBeCloseTo(600 / 2e-7);

    const frame = resolveViewport3DOrthographicCameraFrame(
      null,
      { height: 600, width: 800 },
      undefined,
      3e-7,
    );

    expect(frame.zoom).toBeCloseTo(600 / 3e-7);
  });

  it("aims the orthographic camera at the active viewport target", () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 1e-12, 1e-3);
    const cameraState = {
      position: [2e-6, 1.4e-6, 2e-6] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };

    applyViewport3DOrthographicCameraPose(camera, cameraState, 1e-12, 1e-3);

    const direction = new Vector3();
    camera.getWorldDirection(direction);
    const expected = new Vector3(...cameraState.target)
      .sub(new Vector3(...cameraState.position))
      .normalize();
    expect(direction.angleTo(expected)).toBeLessThan(1e-6);
  });

  it("aims the restored perspective camera at the active viewport target", () => {
    const camera = new PerspectiveCamera(42, 4 / 3, 1e-12, 1e-3);
    const cameraState = {
      position: [2e-6, 1.4e-6, 2e-6] as [number, number, number],
      target: [1e-7, -2e-7, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };

    applyViewport3DPerspectiveCameraPose(camera, cameraState, 1e-12, 1e-3, 42);

    const direction = new Vector3();
    camera.getWorldDirection(direction);
    const expected = new Vector3(...cameraState.target)
      .sub(new Vector3(...cameraState.position))
      .normalize();
    expect(direction.angleTo(expected)).toBeLessThan(1e-6);
    expect(camera.near).toBe(1e-12);
    expect(camera.far).toBe(1e-3);
    expect(camera.fov).toBe(42);
  });

  it("keeps projection clipping beyond the current orbit distance", () => {
    const clip = resolveViewport3DProjectionCameraClip(
      {
        center: [0, 0, 0],
        radius: 5e-8,
        size: [1e-7, 1e-7, 1e-8],
      },
      {
        position: [1.2e-3, 0, 0] as [number, number, number],
        target: [0, 0, 0] as [number, number, number],
        up: [0, 0, 1] as [number, number, number],
      },
    );

    expect(clip.far).toBeGreaterThan(1.2e-3);
  });

  it("does not reapply an unchanged projection clip during demand rendering", () => {
    const camera = new PerspectiveCamera(42, 4 / 3, 1e-12, 1e-3);
    const clip = { far: 1e-3, near: 1e-12 };

    expect(
      shouldApplyViewport3DProjectionCameraClip({
        camera,
        clip,
        previous: null,
      }),
    ).toBe(true);
    expect(
      shouldApplyViewport3DProjectionCameraClip({
        camera,
        clip,
        previous: { camera, clip },
      }),
    ).toBe(false);
    expect(
      shouldApplyViewport3DProjectionCameraClip({
        camera,
        clip: { ...clip, far: 2e-3 },
        previous: { camera, clip },
      }),
    ).toBe(true);
  });

  it("keeps bounds visible when the orthographic target is off center", () => {
    const bounds = {
      center: [0, 0, 0] as [number, number, number],
      radius: Math.sqrt(3) * 5e-8,
      size: [1e-7, 1e-7, 1e-7] as [number, number, number],
    };
    const cameraState = {
      position: [6e-7, 1.4e-6, 2e-6] as [number, number, number],
      target: [5e-7, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };
    const frame = resolveViewport3DOrthographicCameraFrame(
      bounds,
      { height: 600, width: 800 },
      cameraState,
    );
    const camera = new OrthographicCamera(
      frame.left,
      frame.right,
      frame.top,
      frame.bottom,
      1e-12,
      1e-3,
    );
    camera.zoom = frame.zoom;
    applyViewport3DOrthographicCameraPose(camera, cameraState, 1e-12, 1e-3);

    for (const x of [-5e-8, 5e-8]) {
      for (const y of [-5e-8, 5e-8]) {
        for (const z of [-5e-8, 5e-8]) {
          const projected = new Vector3(x, y, z).project(camera);
          expect(Math.abs(projected.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(projected.y)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps projection camera switching deterministic in demand rendering", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("setThreeState({ camera: activeCamera })");
    expect(source).toContain('tracker.recordDirtyFrame("camera-projection")');
    expect(source).not.toContain("makeDefault");
  });

  it("mounts the hysteresis replay glyph layer from the scene model", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("HysteresisReplayGlyphLayer");
    expect(source).toContain("glyphModel={hysteresisReplayGlyphModel}");
    expect(source).toContain("bounds={bounds}");
  });

  it("keeps camera pose out of declarative camera props so OrbitControls owns active gestures", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const orthographicBlock = source.slice(
      source.indexOf("<OrthographicCamera"),
      source.indexOf("/>", source.indexOf("<OrthographicCamera")),
    );
    const perspectiveBlock = source.slice(
      source.indexOf("<PerspectiveCamera"),
      source.indexOf("/>", source.indexOf("<PerspectiveCamera")),
    );

    expect(orthographicBlock).not.toContain("position={cameraState.position}");
    expect(orthographicBlock).not.toContain("up={cameraState.up}");
    expect(orthographicBlock).not.toContain("onUpdate=");
    expect(perspectiveBlock).not.toContain("position={cameraState.position}");
    expect(perspectiveBlock).not.toContain("up={cameraState.up}");
    expect(perspectiveBlock).not.toContain("onUpdate=");
  });

  it("initializes projection cameras with the same world-up used by OrbitControls", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const orthographicBlock = source.slice(
      source.indexOf("<OrthographicCamera"),
      source.indexOf("/>", source.indexOf("<OrthographicCamera")),
    );
    const perspectiveBlock = source.slice(
      source.indexOf("<PerspectiveCamera"),
      source.indexOf("/>", source.indexOf("<PerspectiveCamera")),
    );

    expect(source).toContain("VIEWPORT_3D_WORLD_UP");
    expect(orthographicBlock).toContain("up={VIEWPORT_3D_WORLD_UP}");
    expect(perspectiveBlock).toContain("up={VIEWPORT_3D_WORLD_UP}");
  });

  it("keeps camera gesture state local to Canvas controls", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createViewport3DCameraGestureRef()");
    expect(source).toContain(
      "useMemo(() => createViewport3DCameraGestureRef(), [])",
    );
    expect(source).toContain("cameraGestureRef={cameraGestureRef}");
    expect(source).not.toContain(
      "useRef(createViewport3DCameraGestureRef()).current",
    );
    expect(source).not.toContain("interactionActive={interactionActive}");
  });

  it("owns realized region overlay build status where authored overlay fallback is resolved", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useViewport3DRegionOverlayModels");
    expect(source).toContain("realizedRegionOverlayModels.status");
    expect(source).toContain("models={realizedRegionOverlayModels.models}");
    expect(source).not.toContain("onBuildStatusChange=");
  });

  it("does not mount FEM airbox or topology layers in the FDM scene lane", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const modelStack = source.slice(
      source.indexOf("function Viewport3DModelLayerStack"),
      source.indexOf("function RegionOverlayNativePickingLayer"),
    );

    expect(modelStack).toContain(
      "{!fdmLaneActive &&\n      stageVisibility.baseGeometry &&\n      viewport3DAirboxLayerEnabledFromBrowserConfig() ? (",
    );
    expect(modelStack).toContain(
      "{!fdmLaneActive &&\n      stageVisibility.baseGeometry &&\n      viewport3DTopologyMeshLayerEnabledFromBrowserConfig() ? (",
    );
  });

  it("uses the magnetic-support bounds for the generic FDM domain frame", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "fdmUniverseOutsideSupport?.magneticSupportBounds ??",
    );
    expect(source).not.toContain("bounds={fdmDomain?.bounds ?? bounds}");
  });

  it("can skip viewport canvas probes and orientation widgets from browser runtime flags", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("viewport3DBoundsLayersEnabledFromBrowserConfig");
    expect(source).toContain(
      "viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig",
    );
    expect(source).toContain("viewport3DClipLayersEnabledFromBrowserConfig");
    expect(source).toContain("viewport3DDimensionFrameEnabledFromBrowserConfig");
    expect(source).toContain(
      "viewport3DDimensionFrameLabelsEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "viewport3DDimensionFrameLinesEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig",
    );
    expect(source).toContain("viewport3DFdmCuboidLayerEnabledFromBrowserConfig");
    expect(source).toContain("viewport3DAirboxLayerEnabledFromBrowserConfig");
    expect(source).toContain(
      "viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig",
    );
    expect(source).toContain("viewport3DTopologyMeshLayerEnabledFromBrowserConfig");
    expect(source).toContain(
      "viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "viewport3DOverlayLayersEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "viewport3DOrientationHudEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "viewport3DPostProcessingEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "viewport3DSceneLayersEnabledFromBrowserConfig",
    );
    expect(source).toContain(
      "{viewport3DCanvasLifecycleProbeEnabledFromBrowserConfig() ? (",
    );
    expect(source).toContain("viewport3DOverlayLayersEnabledFromBrowserConfig()");
    expect(source).toContain(
      "viewport3DClipLayersEnabledFromBrowserConfig() && clip?.enabled ? (",
    );
    expect(source).toContain(
      "{viewport3DBoundsLayersEnabledFromBrowserConfig() ? (",
    );
    expect(source).toContain(
      "{viewport3DDimensionFrameEnabledFromBrowserConfig() ? (",
    );
    expect(source).toContain(
      "labelsVisible={",
    );
    expect(source).toContain("scaleLabelsVisible &&");
    expect(source).toContain(
      "viewport3DDimensionFrameLabelsEnabledFromBrowserConfig()",
    );
    expect(source).toContain(
      "majorLinesVisible={",
    );
    expect(source).toContain(
      "minorLinesVisible={",
    );
    expect(source).toContain(
      "viewport3DDimensionFrameMajorLinesEnabledFromBrowserConfig()",
    );
    expect(source).toContain(
      "viewport3DDimensionFrameMinorLinesEnabledFromBrowserConfig()",
    );
    expect(source).toContain("{viewport3DOrientationHudEnabledFromBrowserConfig()");
    expect(source).toContain("viewport3DSceneLayersEnabledFromBrowserConfig()");
    expect(source).toContain("viewport3DFdmCuboidLayerEnabledFromBrowserConfig()");
    expect(source).toContain("viewport3DAirboxLayerEnabledFromBrowserConfig()");
    expect(source).toContain(
      "viewport3DPrimitiveObjectLayerEnabledFromBrowserConfig()",
    );
    expect(source).toContain(
      "viewport3DTopologyMeshLayerEnabledFromBrowserConfig()",
    );
    expect(source).toContain(
      "viewport3DMeshSizeHighlightLayerEnabledFromBrowserConfig()",
    );
    expect(source).toContain("{viewport3DPostProcessingEnabledFromBrowserConfig() ? (");
  });

  it("queues a follow-up projection frame for demand-rendered camera swaps", () => {
    let frameCallback: FrameRequestCallback | null = null;
    const invalidate = vi.fn();
    const tracker = { recordDirtyFrame: vi.fn() };
    const frameHost = {
      cancelAnimationFrame: vi.fn(),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 42;
      }),
    };

    const cleanup = scheduleViewport3DProjectionRenderFrames({
      frameHost,
      invalidate,
      tracker,
    });

    expect(tracker.recordDirtyFrame).toHaveBeenCalledWith("camera-projection");
    expect(invalidate).toHaveBeenCalledTimes(1);

    invokeFrameCallback(frameCallback, 100);

    expect(tracker.recordDirtyFrame).toHaveBeenCalledWith(
      "camera-projection-followup",
    );
    expect(invalidate).toHaveBeenCalledTimes(2);

    cleanup();

    expect(frameHost.cancelAnimationFrame).toHaveBeenCalledWith(42);
  });

  it("stages heavy model layers without disabling the final visualization", () => {
    expect(resolveViewport3DModelLayerStageVisibility(0)).toEqual({
      authoredRegionOverlays: false,
      baseGeometry: false,
      fieldDrivenLayers: false,
      hysteresisReplayGlyphs: false,
      meshSizeHighlight: false,
      primitiveObjects: true,
      realizedRegionOverlays: false,
    });
    expect(resolveViewport3DModelLayerStageVisibility(1)).toMatchObject({
      baseGeometry: true,
      fieldDrivenLayers: false,
    });
    expect(resolveViewport3DModelLayerStageVisibility(2)).toMatchObject({
      baseGeometry: true,
      fieldDrivenLayers: true,
      realizedRegionOverlays: false,
    });
    expect(
      resolveViewport3DModelLayerStageVisibility(
        VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE,
      ),
    ).toEqual({
      authoredRegionOverlays: true,
      baseGeometry: true,
      fieldDrivenLayers: true,
      hysteresisReplayGlyphs: true,
      meshSizeHighlight: true,
      primitiveObjects: true,
      realizedRegionOverlays: true,
    });
  });

  it("advances model layer stages one step at a time", () => {
    expect(resolveNextViewport3DModelLayerStage(0)).toBe(1);
    expect(resolveNextViewport3DModelLayerStage(1)).toBe(2);
    expect(resolveNextViewport3DModelLayerStage(2)).toBe(
      VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE,
    );
    expect(resolveNextViewport3DModelLayerStage(999)).toBe(
      VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE,
    );
  });

  it("commits staged field layers without a transition that external-store updates can starve", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const stageHook = source.slice(
      source.indexOf("function useViewport3DModelLayerStage"),
      source.indexOf("function Viewport3DProjectionStack"),
    );

    expect(stageHook).toContain("window.requestAnimationFrame");
    expect(stageHook).toContain("setStageState((current) =>");
    expect(stageHook).not.toContain("startTransition");
  });
});

describe("Viewport3DScene region overlay visibility", () => {
  it("keeps authored diagnostic picking independent from physical region settings", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );
    const layerInvocation = source.slice(
      source.indexOf("<RegionOverlayNativePickingLayer"),
      source.indexOf("/>", source.indexOf("<RegionOverlayNativePickingLayer")),
    );
    expect(layerInvocation).not.toContain("getRegionSettings");
    expect(layerInvocation).toContain("regions={regionOverlays}");
  });

  it("keeps authored overlays visible in auto mode while realized overlays are building", () => {
    const base = {
      hasMeshBackedRegionOverlays: true,
      overlayLayersEnabled: true,
      regionOverlayMode: "auto" as const,
      stageVisible: true,
    };

    expect(
      resolveAuthoredRegionOverlayVisibility({
        ...base,
        realizedBuildStatus: "pending",
      }),
    ).toBe(true);
    expect(
      resolveAuthoredRegionOverlayVisibility({
        ...base,
        realizedBuildStatus: "stale-visible",
      }),
    ).toBe(true);
    expect(
      resolveAuthoredRegionOverlayVisibility({
        ...base,
        realizedBuildStatus: "ready",
      }),
    ).toBe(false);
    expect(
      resolveAuthoredRegionOverlayVisibility({
        ...base,
        realizedBuildStatus: "pending",
        regionOverlayMode: "realized",
      }),
    ).toBe(false);
    expect(
      resolveAuthoredRegionOverlayVisibility({
        ...base,
        realizedBuildStatus: "ready",
        regionOverlayMode: "both",
      }),
    ).toBe(true);
    expect(
      resolveAuthoredRegionOverlayVisibility({
        ...base,
        realizedBuildStatus: "pending",
        overlayLayersEnabled: false,
      }),
    ).toBe(false);
  });

  it("does not let target region visibility mount diagnostic overlays while global mode is off", () => {
    expect(
      resolveAuthoredRegionOverlayVisibility({
        hasMeshBackedRegionOverlays: false,
        overlayLayersEnabled: true,
        realizedBuildStatus: "disabled",
        regionOverlayMode: "off",
        stageVisible: true,
      }),
    ).toBe(false);
    expect(
      resolveAuthoredRegionOverlayVisibility({
        hasMeshBackedRegionOverlays: false,
        overlayLayersEnabled: false,
        realizedBuildStatus: "disabled",
        regionOverlayMode: "off",
        stageVisible: true,
      }),
    ).toBe(false);
  });

  it("does not treat inherited region visibility as a request for diagnostic overlays", () => {
    expect(
      resolveAuthoredRegionOverlayVisibility({
        hasMeshBackedRegionOverlays: false,
        overlayLayersEnabled: true,
        realizedBuildStatus: "disabled",
        regionOverlayMode: "off",
        stageVisible: true,
      }),
    ).toBe(false);
  });

  it("does not let explicit inspector visibility duplicate mesh-backed region overlays", () => {
    expect(
      resolveAuthoredRegionOverlayVisibility({
        hasMeshBackedRegionOverlays: true,
        overlayLayersEnabled: true,
        realizedBuildStatus: "ready",
        regionOverlayMode: "auto",
        stageVisible: true,
      }),
    ).toBe(false);
  });

  it("renders magnetic FDM cells through target views instead of one domain carrier", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("fdmTargetViews.map((view)");
    expect(source).toContain("instanceOrdinals={view.instanceOrdinals}");
    expect(source).toContain("carrierId={view.target.id}");
    expect(source).toContain("fieldVector={view.fieldVector}");
    expect(source).not.toContain("fieldVector={stagedFieldVector}");
    expect(source).toContain("inspectQuantityId={view.settings.activeQuantityId}");
    expect(source).toContain("settings={view.settings}");
    expect(source).not.toContain("instanceModel={fdmInstanceModel}");
  });

  it("passes each FDM target view identity to its picking callback", () => {
    const source = readFileSync(
      new URL("./Viewport3DScene.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("onSelectTarget={() => onSelectFdmTarget(view.target)}");
  });
});
