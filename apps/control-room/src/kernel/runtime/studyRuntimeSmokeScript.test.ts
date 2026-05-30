import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-study-runtime-control.mjs",
  import.meta.url,
);

describe("study runtime control smoke script", () => {
  it("checks object metrics readback without requiring a solver sample", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:study-runtime-control"]).toBe(
      "node scripts/smoke-study-runtime-control.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("waitForObjectMetrics");
    expect(smokeScript).toContain('typeof value.has_solver_sample === "boolean"');
    expect(smokeScript).not.toContain("value.has_solver_sample === true");
  });
});
