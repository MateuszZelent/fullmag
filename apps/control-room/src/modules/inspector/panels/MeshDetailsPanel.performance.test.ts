import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/MeshDetailsPanel.tsx"),
  "utf8",
);

describe("MeshDetailsPanel performance contracts", () => {
  it("selects only mesh-gating session status fields instead of the full status resource", () => {
    expect(panelSource).toContain("useSessionStatusSelector");
    expect(panelSource).toContain("selectMeshDetailsRuntimeStatus");
    expect(panelSource).toContain("meshDetailsRuntimeStatusEquals");
    expect(panelSource).toContain("shouldLoadRuntimeMeshSummary(true, runtimeStatus)");
    expect(panelSource).toContain("shouldLoadRuntimeMeshBuild(true, runtimeStatus)");
    expect(panelSource).toContain("shouldLoadRuntimeMeshManifest(true, runtimeStatus)");
    expect(panelSource).not.toContain("const sessionStatus = useSessionStatus();");
    expect(panelSource).not.toContain("sessionStatus.data");
  });
});
