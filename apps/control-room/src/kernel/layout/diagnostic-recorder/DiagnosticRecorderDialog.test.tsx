import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/kernel/layout/diagnostic-recorder/DiagnosticRecorderDialog.tsx"),
  "utf8",
);

describe("DiagnosticRecorderDialog", () => {
  it("uses the diagnostic recorder external store and artifact export path", () => {
    expect(source).toContain("useDiagnosticRecorderSnapshot");
    expect(source).toContain("kernel.diagnosticRecorder.exportArtifact()");
    expect(source).toContain("serializeDiagnosticArtifactJson");
  });

  it("exposes expected recorder tabs and controls", () => {
    for (const label of [
      "Overview",
      "Startup",
      "Main Thread",
      "Requests",
      "Memory",
      "Viewport 3D",
      "Build Engine",
      "Console",
      "Export",
    ]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("Start");
    expect(source).toContain("Stop");
    expect(source).toContain("Export JSON");
    expect(source).not.toContain("setInterval");
  });

  it("exposes lightweight viewport build-engine and stale revision diagnostics", () => {
    expect(source).toContain("viewport3dBuildSummary");
    expect(source).toContain("viewport3dVisibleRevisionSummary");
    expect(source).toContain("BuildEngineSummary");
    expect(source).toContain("StaleRevisionSummary");
    expect(source).toContain("WorkerPoolSummary");
    expect(source).toContain("viewport3dWorkerPools");
    expect(source).toContain("Fallbacks");
    expect(source).toContain("fallbackReasons");
    expect(source).not.toContain("requestAnimationFrame");
  });

  it("marks live diagnostic timestamp cells as intentionally hydration-variant", () => {
    const suppressedTimestampCells = source.match(
      /<span role="cell" suppressHydrationWarning>/g,
    );

    expect(suppressedTimestampCells).toHaveLength(2);
    expect(source).not.toContain("new Date(record.timestampMs)");
  });
});
