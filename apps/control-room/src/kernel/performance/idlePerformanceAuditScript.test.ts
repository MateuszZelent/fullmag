import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const auditScriptUrl = new URL(
  "../../../scripts/audit-idle-performance.mjs",
  import.meta.url,
);
describe("idle performance audit script", () => {
  it("is exposed as a package script and only allows documented one-shot demand frames", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const auditScript = readFileSync(auditScriptUrl, "utf8");

    expect(packageJson.scripts?.["audit:idle-performance"]).toBe(
      "node scripts/audit-idle-performance.mjs",
    );
    expect(existsSync(auditScriptUrl)).toBe(true);
    expect(auditScript).toContain("allowsViewport3DDemandFrameOneShots");
    expect(auditScript).toContain("idle-audit-allow-one-shot-raf");
    expect(auditScript).toContain("camera-projection-followup");
    expect(auditScript).toContain("resources-updated");
    expect(auditScript).toContain("model-layer-stage");
    expect(auditScript).toContain("viewport3dGpuUploadManager.ts");
    expect(auditScript).toContain("defaultScheduleFrame");
    expect(auditScript).toContain('frameloop="always"');
    expect(auditScript).toContain("auditVisualizationDebugIdleContracts");
    expect(auditScript).toContain("VisualizationDebugController.ts");
    expect(auditScript).toContain("useViewport3DVisualizationDebugPublisher.ts");
    expect(auditScript).toContain("scanFieldVectorDebugStatistics");
    expect(auditScript).toContain("setInterval(");
  });
});
