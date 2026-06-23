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
});
