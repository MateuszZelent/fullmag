import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "@/kernel/api/apiPaths";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-compute-performance.mjs",
  import.meta.url,
);

describe("compute performance smoke script", () => {
  it("is exposed as a strict browser smoke for runtime compute commands", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:compute-performance"]).toBe(
      "node scripts/smoke-compute-performance.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("STRICT_COMPUTE_ACTIONS");
    expect(smokeScript).toContain('"study.compute-fields"');
    expect(smokeScript).toContain('"study.compute-energies"');
    expect(smokeScript).toContain('"study.run"');
    expect(smokeScript).toContain("window.__FULLMAG_REACT_PROFILER__ = true");
    expect(smokeScript).toContain('observePerformanceEntries("longtask"');
    expect(smokeScript).toContain('observePerformanceEntries("measure"');
    expect(smokeScript).toContain("resetComputePerformanceProbe");
    expect(smokeScript).toContain("__FULLMAG_RESET_COMPUTE_PERFORMANCE__");
    expect(smokeScript).toContain("state.resetStartTime");
    expect(smokeScript).toContain("COMPUTE_RESPONSIVENESS_PROBE_INTERVAL_MS");
    expect(smokeScript).toContain("startResponsivenessProbe");
    expect(smokeScript).toContain("maxResponsivenessDelayMs");
    expect(smokeScript).toContain("totalResponsivenessDelayMs");
    expect(smokeScript).toContain("delayedResponsivenessTickCount");
    expect(smokeScript).toContain("reactRenderMeasureTotals");
    expect(smokeScript).toContain("BINARY_RESOURCE_MEASURE_NAMES");
    expect(smokeScript).toContain("fullmag.api.requestBinaryResource.topology");
    expect(smokeScript).toContain("fullmag.api.requestBinaryResource.mesh-quality-data");
    expect(smokeScript).toContain("fullmag.api.requestBinaryResource.field-vector");
    expect(smokeScript).toContain("fullmag.viewport3d.buildVectorGlyphInstances");
    expect(smokeScript).toContain("fullmag.viewport3d.uploadVectorGlyphColors");
    expect(smokeScript).toContain("fullmag.viewport3d.uploadVectorGlyphMatrices");
    expect(smokeScript).toContain("binaryResourceMeasureCount");
    expect(smokeScript).toContain("binaryResourceMeasureTotals");
    expect(smokeScript).toContain("startsWith(\"fullmag.api.requestBinaryResource.\")");
    expect(smokeScript).toContain("startsWith(\"fullmag.viewport3d.\")");
    expect(smokeScript).toContain("commandRequestCount");
    expect(smokeScript).toContain("waitForComputeActionReady");
    expect(smokeScript).toContain("waitForEnabledAction");
    expect(smokeScript).toContain("waitForCommandAcceptanceFromBrowserResponse");
    expect(smokeScript).toContain("waitForCommandAcceptanceFromLedger");
    expect(smokeScript).toContain("readCommandLedger");
    expect(smokeScript).toContain("cleanupSolveCommand");
    expect(smokeScript).toContain("waitForSolveCleanupState");
    expect(smokeScript).toContain("waitForSolveExecutionProof");
    expect(smokeScript).toContain("hasSolveStageExecutionProof");
    expect(smokeScript).toContain("assertCommandDidNotFail");
    expect(smokeScript).toContain("activeStage?.command_id === commandId");
    expect(smokeScript).toContain(SIMULATION_STAGES_EXECUTION_PATH);
    expect(smokeScript).toContain(SIMULATION_SOLVER_STATUS_PATH);
    expect(smokeScript).toContain("waitForCommandSettled");
    expect(smokeScript).toContain("TERMINAL_COMMAND_STATUSES");
    expect(smokeScript).toContain("Active session status is unavailable");
    expect(smokeScript).toContain("request failed with");
    expect(smokeScript).toContain("commandResponse.status()");
    expect(smokeScript).toContain("FORBIDDEN_ACCEPTANCE_RESOURCE_PATHS");
    expect(smokeScript).toContain("assertNoImmediateResultResourceReloads");
    expect(smokeScript).toContain("resultResourceRequestCount");
    expect(smokeScript).toContain(["", "v2", "sessions", "current", "data", "fields"].join("/"));
    expect(smokeScript).toContain(["", "v2", "sessions", "current", "data", "scalars"].join("/"));
    expect(smokeScript).toContain(["", "v2", "sessions", "current", "simulation", "solver", "energies", "current"].join("/"));
    expect(smokeScript).toContain(["", "v2", "sessions", "current", "simulation", "solver", "energies", "history"].join("/"));
    expect(smokeScript).toContain("simulation\\/objects\\/[^/]+\\/metrics");
    expect(smokeScript).not.toContain("response.status() < 400");
  });
});
