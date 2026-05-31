import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";

import {
  resolveViewport3DPrimaryFieldRenderOptions,
  resolveViewport3DPrimaryFieldQuery,
  resolveViewport3DSceneCameraView,
  resolveViewport3DScopedPartVectorFieldRequests,
  resolveViewport3DScopedVectorFieldQuery,
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

  it("adds sample limits only for scoped vector-only field queries", () => {
    expect(
      resolveViewport3DScopedVectorFieldQuery({
        maxSamples: 384,
        surfaceColorMode: null,
        vectorsVisible: true,
      }),
    ).toEqual({
      component: "full",
      max_samples: 384,
      scope_kind: "full",
    });
    expect(
      resolveViewport3DScopedVectorFieldQuery({
        maxSamples: 384,
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

  it("keeps vector-only magnetic parts on scoped sampled field requests", () => {
    const part = { id: "part:arch_waveguide" };
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: false,
          surfaceColorSource: "magnitude",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [{ part }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests).toEqual(
      new Map([
        [
          "part:arch_waveguide",
          {
            quantityId: "m",
            query: {
              component: "full",
              max_samples: 512,
              scope_kind: "full",
            },
          },
        ],
      ]),
    );

    const primaryOptions = resolveViewport3DPrimaryFieldRenderOptions({
      fieldRenderOptions: {
        fullVectorBudget: 0,
        partVectorBudgets: new Map([["part:arch_waveguide", 512]]),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      },
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: false,
          surfaceColorSource: "magnitude",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [{ part }] as never,
      quantityId: "m",
      scopedVectorOnlyPartIds: new Set(["part:arch_waveguide"]),
      vectorDomain: "auto",
    });

    expect(viewport3DFieldRenderOptionsNeedFieldData(primaryOptions)).toBe(false);
  });

  it("keeps scalar-colored magnetic parts on the unsampled primary path", () => {
    const scopedRequests = resolveViewport3DScopedPartVectorFieldRequests({
      getPartSettings: () =>
        ({
          activeQuantityId: "m",
          shaderVisible: true,
          surfaceColorSource: "magnitude",
          vectorBudget: 512,
          vectorsVisible: true,
          visible: true,
        }) as never,
      magneticParts: [{ part: { id: "part:arch_waveguide" } }] as never,
      vectorDomain: "auto",
    });

    expect(scopedRequests.size).toBe(0);
  });

  it("consumes visualization resources separately from the camera registry", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      'import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";',
    );
    expect(source).toContain(
      'import { useCameraRegistryCamera } from "@/kernel/visualization/useCameraRegistry";',
    );
    expect(source).toContain("const visualizationState = useVisualizationStateResource();");
    expect(source).toContain("const cameraRegistryCamera = useCameraRegistryCamera();");
    expect(source).toContain("const cameraView = resolveViewport3DSceneCameraView({");
    expect(source).toContain("const cameraResource = cameraView.cameraResource;");
    expect(source).not.toContain("useViewport3DVisualizationState");
  });

  it("subscribes to camera registry camera data without rendering on interactionActive flips", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain("useCameraRegistryCamera()");
    expect(source).not.toContain("useCameraRegistrySnapshot()");
    expect(source).not.toContain("interactionActive: cameraView.interactionActive");
    expect(source).not.toContain("resolveCommittedViewport3DFieldVector({");
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
        cameraRegistryCamera: registryCamera,
        commandState,
      }).cameraState,
    ).toEqual(commandState.camera);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(4e-6);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraState,
    ).toEqual(commandState.camera);
    expect(
      resolveViewport3DSceneCameraView({
        cameraRegistryCamera: {
          ...registryCamera,
          orthographic_scale: 2.5e-6,
          projection: "orthographic",
        },
        commandState,
      }).cameraOrthographicScale,
    ).toBe(4e-6);
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
