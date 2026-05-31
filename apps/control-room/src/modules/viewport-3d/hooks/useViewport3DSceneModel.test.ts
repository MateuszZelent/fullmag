import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";

import {
  resolveCommittedViewport3DFieldVector,
  resolveViewport3DPrimaryFieldRenderOptions,
  resolveViewport3DPrimaryFieldQuery,
  resolveViewport3DSceneCameraView,
  resolveViewport3DTargetFieldQuery,
} from "./useViewport3DSceneModel";
import { viewport3DFieldRenderOptionsNeedFieldData } from "../viewport3dRenderModel";
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
  it("requests scalar field components when the primary field is only used for scalar surface colors", () => {
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(["magnitude"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "magnitude",
      scope_kind: "full",
    });
  });

  it("keeps full field vectors when glyphs or orientation colors need vector components", () => {
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 256,
          scalarColorModes: new Set(["magnitude"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
    expect(
      resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector: false,
        fdmSurfaceColorMode: null,
        fdmTopographyEnabled: false,
        fdmVectorsVisible: false,
        fieldRenderOptions: {
          fullVectorBudget: 0,
          partVectorBudgets: new Map(),
          scalarColorModes: new Set(["orientation"]),
          scalarColorsVisible: true,
        },
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

  it("resolves target-specific scalar field queries unless vectors need full components", () => {
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: "x",
        vectorsVisible: false,
      }),
    ).toEqual({
      component: "x",
      scope_kind: "full",
    });
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: "orientation",
        vectorsVisible: false,
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: "magnitude",
        vectorsVisible: true,
      }),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

  it("does not let scoped airbox vectors force a full-domain primary field request", () => {
    const primaryOptions = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part:__air__", 1024]]),
        scalarColorModes: new Set(["orientation"]),
        scalarColorsVisible: true,
      },
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "magnitude",
          vectorBudget: 256,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [
        {
          part: { id: "part:arch_waveguide" },
        },
      ] as never,
      quantityId: "h_demag",
      vectorDomain: "auto",
    });

    expect(viewport3DFieldRenderOptionsNeedFieldData(primaryOptions)).toBe(false);
    expect(resolveViewport3DPrimaryFieldQuery({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: primaryOptions,
    })).toEqual({
      component: "full",
      scope_kind: "full",
    });
  });

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

  it("surfaces field-vector load failures as explicit viewport issues", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("fieldDataIssue");
    expect(source).toContain("fieldVectorEnabled && fieldVector.error");
    expect(source).toContain("resolveViewport3DFieldVectorResourceKey");
  });

  it("loads airbox field data through scoped airbox requests instead of full-domain target requests", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("const airboxFieldVectorEnabled = Boolean(");
    expect(source).toContain("airboxSurfaceColorMode");
    expect(source).toContain("useViewport3DAirboxFieldVectors(");
    expect(source).not.toContain("ids.add(airboxSettings.activeQuantityId)");
  });

  it("keeps cross-section draft previews separate from the canonical clip resource path", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("activeCrossSectionFramePreview");
    expect(source).toContain("crossSectionFramePreviewToClip");
    expect(source).toContain("enabled: Boolean(renderingState?.clip?.enabled && topologyCurrent)");
    expect(source).toContain("crossSectionFrameClip");
    expect(source).toContain("clipFrameRotationDegrees: 0");
  });

  it("uses the local viewport camera for live scene rendering", () => {
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
    ).toEqual(commandState.camera);
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
    ).toBe(4e-6);
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

  it("keeps the committed field vector stable while the camera interaction is active", () => {
    const current = {
      quantityId: "m",
      values: new Float64Array([1, 0, 0]),
    } as never;
    const next = {
      quantityId: "m",
      values: new Float64Array([0, 1, 0]),
    } as never;

    expect(
      resolveCommittedViewport3DFieldVector({
        current,
        interactionActive: true,
        next,
      }),
    ).toBe(current);
  });

  it("adopts the latest field vector once camera interaction stops", () => {
    const current = {
      quantityId: "m",
      values: new Float64Array([1, 0, 0]),
    } as never;
    const next = {
      quantityId: "m",
      values: new Float64Array([0, 1, 0]),
    } as never;

    expect(
      resolveCommittedViewport3DFieldVector({
        current,
        interactionActive: false,
        next,
      }),
    ).toBe(next);
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
