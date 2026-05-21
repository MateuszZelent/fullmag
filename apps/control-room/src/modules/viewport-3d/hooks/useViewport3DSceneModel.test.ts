import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
    expect(source).toContain("const cameraResource = cameraRegistrySnapshot.camera;");
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
