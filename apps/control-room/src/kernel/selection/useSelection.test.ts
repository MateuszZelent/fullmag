import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const useSelectionSource = readFileSync(
  join(process.cwd(), "src/kernel/selection/useSelection.ts"),
  "utf8",
);
const selectionTypesSource = readFileSync(
  join(process.cwd(), "src/kernel/selection/selectionTypes.ts"),
  "utf8",
);
const selectionControllerSource = readFileSync(
  join(process.cwd(), "src/kernel/selection/SelectionController.ts"),
  "utf8",
);
const explorerModuleSource = readFileSync(
  join(process.cwd(), "src/modules/explorer/ExplorerModule.tsx"),
  "utf8",
);
const footerTelemetrySource = readFileSync(
  join(process.cwd(), "src/modules/footer/FooterTelemetry.tsx"),
  "utf8",
);
const ribbonModuleSource = readFileSync(
  join(process.cwd(), "src/modules/ribbon/RibbonModule.tsx"),
  "utf8",
);
const inspectorModuleSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/InspectorModule.tsx"),
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

describe("selection subscription performance contracts", () => {
  it("exposes selector and action hooks for narrow selection subscriptions", () => {
    expect(useSelectionSource).toContain("export function useSelectionSelector");
    expect(useSelectionSource).toContain("selector(selection.get())");
    expect(useSelectionSource).toContain("export function useSelectionActions");
    expect(useSelectionSource).toContain("options: { isEqual?:");
  });

  it("uses selector subscriptions for read-only module selection fields", () => {
    expect(explorerModuleSource).toContain("useSelectionSelector");
    expect(explorerModuleSource).not.toContain("const { selection } = useSelection(moduleId)");

    expect(footerTelemetrySource).toContain("useSelectionSelector");
    expect(footerTelemetrySource).not.toContain('const { selection } = useSelection("footer")');

    expect(ribbonModuleSource).toContain("useSelectionSelector");
    expect(ribbonModuleSource).toContain("activeTab === \"view\"");
    expect(ribbonModuleSource).not.toContain("const { selection } = useSelection(moduleId)");
  });

  it("compares typed selection refs without JSON serialization", () => {
    expect(selectionTypesSource).toContain("export function selectionRefEquals");
    expect(selectionTypesSource).toContain("export function selectionSnapshotEquals");
    expect(selectionTypesSource).not.toContain("JSON.stringify");
    expect(selectionControllerSource).not.toContain("JSON.stringify");
    expect(useSelectionSource).not.toContain("JSON.stringify");
  });

  it("keeps inspector and viewport off the broad selection hook", () => {
    expect(inspectorModuleSource).toContain("useSelectionSelector");
    expect(inspectorModuleSource).not.toContain("useSelection(moduleId)");

    expect(viewportModuleSource).toContain("useSelectionSelector");
    expect(viewportModuleSource).toContain("useSelectionActions");
    expect(viewportModuleSource).not.toContain("useSelection(moduleId)");
    expect(viewportSceneModelSource).not.toContain("ReturnType<typeof useSelection>");
  });
});
