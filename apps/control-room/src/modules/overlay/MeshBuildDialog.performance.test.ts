import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(
  join(process.cwd(), "src/modules/overlay/MeshBuildDialog.tsx"),
  "utf8",
);

describe("MeshBuildDialog performance contracts", () => {
  it("selects only mesh-gating session status fields instead of the full status resource", () => {
    expect(dialogSource).toContain("useSessionStatusSelector");
    expect(dialogSource).toContain("selectMeshBuildDialogRuntimeStatus");
    expect(dialogSource).toContain("meshBuildDialogRuntimeStatusEquals");
    expect(dialogSource).toContain("shouldLoadMeshBuildDialogFemResources");
    expect(dialogSource).toContain("enabled: explicitFemLane");
    expect(dialogSource).toContain("FDM_MESH_COMMAND_NOT_APPLICABLE_REASON");
    expect(dialogSource).toContain("shouldLoadRuntimeMeshBuild(state.open, runtimeStatus)");
    expect(dialogSource).toContain("shouldLoadRuntimeMeshSummary(state.open, runtimeStatus)");
    expect(dialogSource).toContain("shouldLoadRuntimeMeshManifest(state.open, runtimeStatus)");
    expect(dialogSource).not.toContain("const sessionStatus = useSessionStatus();");
    expect(dialogSource).not.toContain("sessionStatus.data");
  });
});
