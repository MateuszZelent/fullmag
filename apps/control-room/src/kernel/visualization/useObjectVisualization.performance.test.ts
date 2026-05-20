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
const objectVisualizationControllerSource = readFileSync(
  join(process.cwd(), "src/kernel/visualization/ObjectVisualizationController.ts"),
  "utf8",
);

describe("object visualization subscription performance contracts", () => {
  it("exposes selector and controller hooks for narrow visualization subscriptions", () => {
    expect(hookSource).toContain("export function useObjectVisualizationSelector");
    expect(hookSource).toContain("selector(visualization.getSnapshot())");
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
});
