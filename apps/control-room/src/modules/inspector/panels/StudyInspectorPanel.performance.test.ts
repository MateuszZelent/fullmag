import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/StudyInspectorPanel.tsx"),
  "utf8",
);

describe("StudyInspectorPanel performance contracts", () => {
  it("selects only runtime-gating session status fields instead of the full status resource", () => {
    expect(panelSource).toContain("useSessionStatusSelector");
    expect(panelSource).toContain("selectStudyInspectorRuntimeStatus");
    expect(panelSource).toContain("studyInspectorRuntimeStatusEquals");
    expect(panelSource).toContain("shouldLoadRuntimeCurrentRun(true, runtimeStatus)");
    expect(panelSource).toContain("shouldLoadRuntimeStageExecution(true, runtimeStatus)");
    expect(panelSource).toContain("shouldLoadRuntimeMeshBuild(true, runtimeStatus)");
    expect(panelSource).toContain("shouldLoadRuntimeMeshManifest(true, runtimeStatus)");
    expect(panelSource).toContain("shouldLoadRuntimeMeshSummary(true, runtimeStatus)");
    expect(panelSource).toContain("shouldLoadRuntimeScalars(true, runtimeStatus)");
    expect(panelSource).not.toContain("const sessionStatus = useSessionStatus();");
    expect(panelSource).not.toContain("sessionStatus.data");
  });
});
