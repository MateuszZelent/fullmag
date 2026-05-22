import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";

import {
  resolveViewport3DSceneCameraView,
} from "./useViewport3DSceneModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  type Viewport3DCommandState,
} from "../viewport3dStore";

const sceneModelSourceUrl = new URL("./useViewport3DSceneModel.ts", import.meta.url);
const visualizationStateResourceSourceUrl = new URL(
  "../../../kernel/visualization/useVisualizationStateResource.ts",
  import.meta.url,
);

describe("useViewport3DSceneModel", () => {
  it("consumes visualization resources separately from the camera registry", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      'import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";',
    );
    expect(source).toContain(
      'import { useCameraRegistrySnapshot } from "@/kernel/visualization/useCameraRegistry";',
    );
    expect(source).toContain("const visualizationState = useVisualizationStateResource();");
    expect(source).toContain("const cameraRegistrySnapshot = useCameraRegistrySnapshot();");
    expect(source).toContain("const cameraView = resolveViewport3DSceneCameraView({");
    expect(source).toContain("const cameraResource = cameraView.cameraResource;");
    expect(source).not.toContain("useViewport3DVisualizationState");
  });

  it("observes backend camera state in the kernel registry without remote camera overwrite logic in the scene model", () => {
    const sceneModelSource = readFileSync(sceneModelSourceUrl, "utf8");
    const visualizationStateResourceSource = readFileSync(
      visualizationStateResourceSourceUrl,
      "utf8",
    );

    expect(visualizationStateResourceSource).toContain(
      "cameraRegistry.observeRemoteState(resource.data);",
    );
    expect(sceneModelSource).not.toContain("hasUnsatisfiedCameraPatch");
    expect(sceneModelSource).not.toContain("useViewport3DRemoteCameraSync");
  });

  it("uses the local viewport camera while a camera interaction is active", () => {
    const commandState = {
      camera: {
        position: [3, 2, 1],
        target: [0.5, 0.25, 0],
        up: [0, 0, 1],
      },
      widgets: {
        cameraOrthographicScale: 4e-6,
        cameraProjection: "perspective",
      },
    } as Pick<Viewport3DCommandState, "camera" | "widgets">;
    const registryCamera = {
      ...DEFAULT_CAMERA_REGISTRY_STATE,
      position: DEFAULT_VIEWPORT_3D_CAMERA_STATE.position,
      target: DEFAULT_VIEWPORT_3D_CAMERA_STATE.target,
      up: DEFAULT_VIEWPORT_3D_CAMERA_STATE.up,
    };

    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistrySnapshot: {
          camera: registryCamera,
          interactionActive: true,
        },
        commandState,
      }).cameraState,
    ).toEqual(commandState.camera);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistrySnapshot: {
          camera: {
            ...registryCamera,
            orthographic_scale: 2.5e-6,
            projection: "orthographic",
          },
          interactionActive: true,
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(4e-6);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistrySnapshot: {
          camera: {
            ...registryCamera,
            orthographic_scale: 2.5e-6,
            projection: "orthographic",
          },
          interactionActive: false,
        },
        commandState,
      }).cameraState,
    ).toEqual(DEFAULT_VIEWPORT_3D_CAMERA_STATE);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistrySnapshot: {
          camera: {
            ...registryCamera,
            orthographic_scale: 2.5e-6,
            projection: "orthographic",
          },
          interactionActive: false,
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(2.5e-6);
  });

  it("exposes the camera interaction state to the 3D scene", () => {
    const commandState = {
      camera: DEFAULT_VIEWPORT_3D_CAMERA_STATE,
      widgets: {
        cameraOrthographicScale: 4e-6,
        cameraProjection: "perspective",
      },
    } as Pick<Viewport3DCommandState, "camera" | "widgets">;

    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistrySnapshot: {
          camera: DEFAULT_CAMERA_REGISTRY_STATE,
          interactionActive: true,
        },
        commandState,
      }).interactionActive,
    ).toBe(true);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistrySnapshot: {
          camera: DEFAULT_CAMERA_REGISTRY_STATE,
          interactionActive: false,
        },
        commandState,
      }).interactionActive,
    ).toBe(false);
  });

  it("builds the FDM instance model once in the scene model without coupling solid rendering to field revisions", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const fdmInstanceModelEnabled = Boolean(");
    expect(source).toContain("const fdmInstanceModelNeedsFieldVector =");
    expect(source).toContain("const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector");
    expect(source).toContain("const fdmInstanceModel = useMemo<");
    expect(source).toContain("if (!fdmInstanceModelEnabled) return undefined;");
    expect(source).toContain("fieldVector: fdmInstanceModelFieldVector");
    expect(source).toContain("fdmInstanceModel: fdmInstanceModel");
    expect(source).not.toContain("const fdmSurfaceInstanceModel");
  });
});
