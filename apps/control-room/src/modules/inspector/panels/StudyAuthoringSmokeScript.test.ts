import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../../scripts/smoke-study-authoring-ui.mjs",
  import.meta.url,
);

describe("study authoring UI smoke script", () => {
  it("drives Study inspector authoring through fixture-backed model transactions", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:study-authoring-ui"]).toBe(
      "node scripts/smoke-study-authoring-ui.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain('[data-node-id="model:study"]');
    expect(smokeScript).toContain("Save globals");
    expect(smokeScript).toContain("Save stages");
    expect(smokeScript).toContain("model/transactions");
    expect(smokeScript).toContain("model/objects/film/regions");
    expect(smokeScript).toContain("waitForRegionScriptSyncCount");
    expect(smokeScript).toContain("assertCreatedRegion");
    expect(smokeScript).toContain("assertGlobalTransaction");
    expect(smokeScript).toContain("assertStageTransaction");
    expect(smokeScript).toContain('entrypoint_kind !== "flat_relax"');
    expect(smokeScript).toContain('entrypoint_kind !== "flat_run"');
    expect(smokeScript).toContain("requested_cpu_threads");
    expect(smokeScript).toContain("fem_demag_solver_policy");
    expect(smokeScript).toContain("makeEigenModeFieldVectorBuffer");
    expect(smokeScript).toContain("makeFrequencyResponseFieldVectorBuffer");
    expect(smokeScript).toContain("assertStableViewport3DCanvas");
    expect(smokeScript).toContain("view=phase_rotated_real");
    expect(smokeScript).toContain("await plotButton.click()");
    expect(smokeScript).toContain("waitForFrequencyResponseFieldVectorRequest");
    expect(smokeScript).toContain(
      '[data-inspector-surface="fmr-response-sweep"]',
    );
  });
});
