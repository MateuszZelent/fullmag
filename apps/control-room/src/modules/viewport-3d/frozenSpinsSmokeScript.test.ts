import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const smokeScriptUrl = new URL(
  "../../../scripts/smoke-frozen-spins.mjs",
  import.meta.url,
);

describe("Frozen Spins browser smoke contract", () => {
  it("accepts both valid FEM scalar carrier adoption paths without weakening render proof", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("viewportHasCompleteFemScalarCarrier");
    expect(smokeScript).toContain("viewportText.includes('scalar-complete')");
    expect(smokeScript).toContain("viewportText.includes('state=derived-global')");
    expect(smokeScript).toContain("field?.state === 'complete'");
    expect(smokeScript).toContain("field?.kind === 'spatial_scalar'");
    expect(smokeScript).toContain("surface-vertex-colors:ready");
    expect(smokeScript).toContain("!text.includes('surface-colors-unavailable')");
    expect(smokeScript).toContain("Frozen Spins data-plane responses:");
    expect(smokeScript).toContain("Authoring workflow must end with a rendered visualization ACK");
    expect(smokeScript).toContain("Frozen Spins 3D rendering must not degrade");
  });

  it("fails closed unless Preview and solver share one positive source-state revision", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      "Committed preview must publish a positive source_state_revision",
    );
    expect(smokeScript).toContain(
      "Solver certificate must publish a positive source_state_revision",
    );
    expect(smokeScript).toContain(
      "solverSourceStateRevision === previewSourceStateRevision",
    );
    expect(smokeScript).toContain(
      "Solver certificate source_state_revision must match the committed preview",
    );
  });

  it("records a positive end-to-end Preview request wall time", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("process.hrtime.bigint()");
    expect(smokeScript).toContain(
      "Successful Preview must publish a positive end-to-end wall time",
    );
    expect(smokeScript).toContain("request_wall_time_ns: previewRequestWallTimeNs");
    expect(smokeScript).toContain("attempt_wall_time_ns: previewAttemptWallTimeNs");
  });
});
