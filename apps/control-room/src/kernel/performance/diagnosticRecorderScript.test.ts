import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  join(process.cwd(), "scripts/record-diagnostics.mjs"),
  "utf8",
);

describe("diagnostic recorder script", () => {
  it("accepts the expected recorder environment variables", () => {
    for (const name of [
      "CONTROL_ROOM_URL",
      "CONTROL_ROOM_API_BASE_URL",
      "CONTROL_ROOM_DIAGNOSTICS_SCENARIO",
      "CONTROL_ROOM_DIAGNOSTICS_INTERACTIVE",
      "CONTROL_ROOM_DIAGNOSTICS_HEADLESS",
      "CONTROL_ROOM_DIAGNOSTICS_OUTPUT_DIR",
      "CONTROL_ROOM_DIAGNOSTICS_ALLOW_MISSING_SESSION",
      "CONTROL_ROOM_DIAGNOSTICS_TRACE",
      "CONTROL_ROOM_DIAGNOSTICS_TIMEOUT_MS",
      "CONTROL_ROOM_DIAGNOSTICS_CANVAS_TIMEOUT_MS",
    ]) {
      expect(script).toContain(name);
    }
  });

  it("enables in-page recorder, CDP metrics, screenshots, and artifact directory output", () => {
    expect(script).toContain("enableDiagnosticRecorder: true");
    expect(script).toContain("Performance.getMetrics");
    expect(script).toContain("Runtime.getHeapUsage");
    expect(script).toContain("screenshots");
    expect(script).toContain("suspect-report.md");
    expect(script).toContain("viewport-3d.ndjson");
    expect(script).toContain("__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__");
  });
});
