import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/modules/footer/DiagnosticRecorderFooterPanel.tsx"),
  "utf8",
);

describe("DiagnosticRecorderFooterPanel", () => {
  it("uses the diagnostic recorder external store and export artifact", () => {
    expect(source).toContain("useDiagnosticRecorderSnapshot");
    expect(source).toContain("kernel.diagnosticRecorder.exportArtifact()");
    expect(source).toContain("serializeDiagnosticArtifactJson");
  });

  it("can request the full recorder dialog without owning dialog state", () => {
    expect(source).toContain("diagnostics:recorder-open-requested");
    expect(source).toContain("Open");
    expect(source).toContain("Export");
  });
});
