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

  it("keeps the browser workspace open while command buttons update from realtime", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("await openWorkspaceIfRequested()");
    expect(smokeScript).toContain("workspace?.close()");
    expect(smokeScript).toContain("controlRoomApiBase");
    expect(smokeScript).toContain("wrongApiRequests");
    expect(smokeScript).toContain("CONTROL_ROOM_STUDY_SMOKE_BUTTON_STATE_ONLY");
    expect(smokeScript).toContain("Study runtime button-state smoke passed");
    expect(smokeScript).toContain("waitForRuntimeRibbonControlState");
    expect(smokeScript).toContain('data-action-id="${commandId}"');
    expect(smokeScript).toContain('"study.run"');
    expect(smokeScript).toContain('"study.pause"');
    expect(smokeScript).toContain('"study.resume"');
    expect(smokeScript).toContain('"study.stop"');
    expect(smokeScript).toContain('"study.discard-paused-state"');
    expect(smokeScript).toContain("discard_paused_state");
    expect(smokeScript).toContain("Paused state discarded");
    expect(smokeScript).toContain("Stop ribbon button enabled while runtime is running");
    expect(smokeScript).toContain("runtimeActiveTitlePattern");
    expect(smokeScript).toContain("runtime command");
    expect(smokeScript).toContain("Runtime is not running");
  });
});
