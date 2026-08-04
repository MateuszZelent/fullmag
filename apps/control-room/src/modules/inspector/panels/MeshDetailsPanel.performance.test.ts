import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/MeshDetailsPanel.tsx"),
  "utf8",
);
const modelSource = readFileSync(
  join(
    process.cwd(),
    "src/modules/inspector/panels/mesh-details/useMeshDetailsModel.ts",
  ),
  "utf8",
);

describe("MeshDetailsPanel performance contracts", () => {
  it("selects only mesh-gating session status fields instead of the full status resource", () => {
    expect(panelSource).toContain("useMeshDetailsModel");
    expect(modelSource).toContain("useSessionStatusSelector");
    expect(modelSource).toContain("selectMeshDetailsRuntimeStatus");
    expect(modelSource).toContain("meshDetailsRuntimeStatusEquals");
    expect(modelSource).toContain("shouldLoadRuntimeMeshSummary(true, runtimeStatus)");
    expect(modelSource).toContain("shouldLoadRuntimeMeshBuild(true, runtimeStatus)");
    expect(modelSource).toContain("shouldLoadRuntimeMeshManifest(true, runtimeStatus)");
    expect(modelSource).toContain('const femLane = lane === "fem";');
    expect(modelSource).toContain("shouldLoadMeshDetailsFemResources");
    expect(modelSource).toContain("useSceneResource({ enabled: femLane })");
    expect(modelSource).toContain(
      'useMeshSemanticsResource({ enabled: femLane })',
    );
    expect(modelSource).toContain('if (!femLane) return;');
    expect(modelSource).not.toContain("const sessionStatus = useSessionStatus();");
    expect(modelSource).not.toContain("sessionStatus.data");
  });
});
