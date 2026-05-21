import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sceneModelSourceUrl = new URL("./useViewport3DSceneModel.ts", import.meta.url);
const visualizationStateResourceSourceUrl = new URL(
  "../../../kernel/visualization/useVisualizationStateResource.ts",
  import.meta.url,
);

describe("useViewport3DSceneModel", () => {
  it("consumes the optimistic visualization state resource for camera projection patches", () => {
    const source = readFileSync(sceneModelSourceUrl, "utf8");

    expect(source).toContain(
      'import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";',
    );
    expect(source).toContain("const visualizationState = useVisualizationStateResource();");
    expect(source).not.toContain("useViewport3DVisualizationState");
  });

  it("checks pending camera patches against raw remote visualization state", () => {
    const sceneModelSource = readFileSync(sceneModelSourceUrl, "utf8");
    const visualizationStateResourceSource = readFileSync(
      visualizationStateResourceSourceUrl,
      "utf8",
    );

    expect(visualizationStateResourceSource).toContain("rawData: resource.data");
    expect(sceneModelSource).toContain(
      "visualizationSync.hasUnsatisfiedCameraPatch(visualizationState.rawData)",
    );
    expect(sceneModelSource).not.toContain(
      "visualizationSync.hasUnsatisfiedCameraPatch(renderingState)",
    );
  });
});
