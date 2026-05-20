import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const useSelectionSource = readFileSync(
  join(process.cwd(), "src/kernel/selection/useSelection.ts"),
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

describe("selection subscription performance contracts", () => {
  it("exposes a selector hook for narrow read-only subscriptions", () => {
    expect(useSelectionSource).toContain("export function useSelectionSelector");
    expect(useSelectionSource).toContain("selector(selection.get())");
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
});
