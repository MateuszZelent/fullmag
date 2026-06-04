import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const useResourceSource = readFileSync(
  join(process.cwd(), "src/kernel/resources/useResource.ts"),
  "utf8",
);
const useSessionStatusSource = readFileSync(
  join(process.cwd(), "src/kernel/resources/useSessionStatus.ts"),
  "utf8",
);
const explorerModuleSource = readFileSync(
  join(process.cwd(), "src/modules/explorer/ExplorerModule.tsx"),
  "utf8",
);
const ribbonModuleSource = readFileSync(
  join(process.cwd(), "src/modules/ribbon/RibbonModule.tsx"),
  "utf8",
);
const footerTelemetrySource = readFileSync(
  join(process.cwd(), "src/modules/footer/FooterTelemetry.tsx"),
  "utf8",
);
const statusBarSource = readFileSync(
  join(process.cwd(), "src/modules/status-bar/StatusBarModule.tsx"),
  "utf8",
);

describe("session status subscription performance contracts", () => {
  it("exposes a resource selector primitive and session status selector hook", () => {
    expect(useResourceSource).toContain("export function useResourceSelector");
    expect(useResourceSource).toContain("selector(visibleState)");
    expect(useResourceSource).toContain("isEqual(previous.selected, selected)");
    expect(useSessionStatusSource).toContain("export function useSessionStatusSelector");
  });

  it("centrally rate-limits session status refetches across all status consumers", () => {
    expect(useSessionStatusSource).toContain("statusRefreshIntervalMs");
    expect(useSessionStatusSource).toContain(
      "minRefetchIntervalMs: statusRefreshIntervalMs()",
    );
  });

  it("uses session status selectors in broad shell consumers", () => {
    for (const source of [
      explorerModuleSource,
      ribbonModuleSource,
      footerTelemetrySource,
      statusBarSource,
    ]) {
      expect(source).toContain("useSessionStatusSelector");
    }

    expect(explorerModuleSource).toContain("selectExplorerModelRuntimeStatus");
    expect(explorerModuleSource).toContain("explorerModelRuntimeStatusEquals");
    expect(explorerModuleSource).toContain("sessionStatusData");
    expect(explorerModuleSource).not.toContain("const sessionStatus = useSessionStatus()");
    expect(explorerModuleSource).not.toContain("sessionStatus.data");

    expect(ribbonModuleSource).toContain("selectRibbonRuntimeStatus");
    expect(ribbonModuleSource).toContain("ribbonRuntimeStatusEquals");
    expect(ribbonModuleSource).toContain("field_revision");
    expect(ribbonModuleSource).toContain("fields_revision");
    expect(ribbonModuleSource).not.toContain("const sessionStatus = useSessionStatus()");
    expect(ribbonModuleSource).not.toContain("sessionStatus.data");
    expect(footerTelemetrySource).not.toContain("const { data: status } = useSessionStatus()");
    expect(statusBarSource).not.toContain("const status = useSessionStatus()");
  });
});
