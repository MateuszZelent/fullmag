import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/AirboxMeshPolicyPanel.tsx"),
  "utf8",
);

describe("AirboxMeshPolicyPanel performance contracts", () => {
  it("selects only mesh-summary session status fields instead of the full status resource", () => {
    expect(panelSource).toContain("useSessionStatusSelector");
    expect(panelSource).toContain("selectAirboxMeshPolicyRuntimeStatus");
    expect(panelSource).toContain("airboxMeshPolicyRuntimeStatusEquals");
    expect(panelSource).toContain("shouldLoadRuntimeMeshSummary(true, runtimeStatus)");
    expect(panelSource).not.toContain("const sessionStatus = useSessionStatus();");
    expect(panelSource).not.toContain("sessionStatus.data");
  });
});
