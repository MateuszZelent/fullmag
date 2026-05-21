import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hookSource = readFileSync(
  join(process.cwd(), "src/kernel/visualization/useObjectVisualization.ts"),
  "utf8",
);
const ribbonModuleSource = readFileSync(
  join(process.cwd(), "src/modules/ribbon/RibbonModule.tsx"),
  "utf8",
);
const appMenuSource = readFileSync(
  join(process.cwd(), "src/kernel/layout/AppMenuBar.tsx"),
  "utf8",
);
const geometryObjectPanelSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/GeometryObjectPanel.tsx"),
  "utf8",
);
const viewportModuleSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/Viewport3DModule.tsx"),
  "utf8",
);
const viewportSceneModelSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts"),
  "utf8",
);
const objectVisualizationControllerSource = readFileSync(
  join(process.cwd(), "src/kernel/visualization/ObjectVisualizationController.ts"),
  "utf8",
);

describe("object visualization subscription performance contracts", () => {
  it("exposes selector and controller hooks for narrow visualization subscriptions", () => {
    expect(hookSource).toContain("export function useObjectVisualizationSelector");
    expect(hookSource).toContain("selector(visualization.getSnapshot())");
    expect(hookSource).toContain("isEqual(previous.selected, selected)");
    expect(hookSource).toContain("selectedRef.current");
    expect(hookSource).toContain("export function useObjectVisualizationController");
    expect(hookSource).toContain("EMPTY_OBJECT_VISUALIZATION_SNAPSHOT");
  });

  it("keeps JSON serialization out of object visualization patch equality", () => {
    const samePatchStart = objectVisualizationControllerSource.indexOf("function samePatch");
    expect(samePatchStart).toBeGreaterThanOrEqual(0);
    const samePatchBlock = objectVisualizationControllerSource.slice(samePatchStart);

    expect(samePatchBlock).toContain("Object.is");
    expect(samePatchBlock).not.toContain("JSON.stringify");
  });

  it("keeps ribbon and app menu off the full visualization snapshot unless needed", () => {
    expect(ribbonModuleSource).toContain("useObjectVisualizationSelector");
    expect(ribbonModuleSource).toContain("activeTab === \"view\"");
    expect(ribbonModuleSource).not.toContain("useObjectVisualizationRegistry()");

    expect(appMenuSource).toContain("useObjectVisualizationSelector");
    expect(appMenuSource).toContain("registryOpen ? snapshot : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT");
    expect(appMenuSource).not.toContain("useObjectVisualizationRegistry()");
  });

  it("keeps geometry object color editing off the full visualization snapshot", () => {
    expect(geometryObjectPanelSource).toContain("useObjectVisualizationController");
    expect(geometryObjectPanelSource).toContain("useObjectVisualizationSelector");
    expect(geometryObjectPanelSource).toContain("geometryObjectVisualizationColorsEquals");
    expect(geometryObjectPanelSource).toContain("resolveGeometryObjectVisualizationColors");
    expect(geometryObjectPanelSource).not.toContain("useObjectVisualizationRegistry()");
  });

  it("keeps viewport rendering off the full visualization registry snapshot", () => {
    expect(viewportModuleSource).not.toContain("useObjectVisualizationRegistry()");
    expect(viewportSceneModelSource).toContain("useObjectVisualizationSelector");
    expect(viewportSceneModelSource).toContain("selectViewport3DObjectVisualizationSnapshot");
    expect(viewportSceneModelSource).toContain("viewport3DObjectVisualizationSnapshotEquals");
    expect(viewportSceneModelSource).toContain("visualizationTargetKey");
    expect(viewportSceneModelSource).not.toContain(
      "ReturnType<typeof useObjectVisualizationRegistry>",
    );
  });
});
