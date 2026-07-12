import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const smokeScript = readFileSync(
  new URL("../../../../scripts/smoke-study-authoring-ui.mjs", import.meta.url),
  "utf8",
);

describe("study authoring smoke script", () => {
  it("asserts current FMR modal spectrum headings", () => {
    expect(smokeScript).toContain(
      '[data-inspector-surface="fmr-modal-spectrum"]',
    );
    expect(smokeScript).toContain("FMR Modal Spectrum Control");
    expect(smokeScript).toContain("FMR Modal Spectrum Chart");
    expect(smokeScript).not.toContain('name: "Modal Spectrum"');
  });

  it("asserts current Eigen mode inspector headings", () => {
    expect(smokeScript).toContain('[data-inspector-surface="eigen-mode"]');
    expect(smokeScript).toContain("Eigen Mode Control");
    expect(smokeScript).toContain("Eigen Mode 3D Visualization");
    expect(smokeScript).toContain(
      "Plot selected eigen mode with phase-rotated real display",
    );
    expect(smokeScript).toContain(
      'article.fm-frequency-domain-response-card[data-status="ready"]',
    );
    expect(smokeScript).toContain(
      'name: "Plot 3D"',
    );
    expect(smokeScript).not.toContain("Selected Eigen Mode");
    expect(smokeScript).not.toContain("Plot mode rotated");
  });

  it("reports Explorer row selection state after smoke clicks", () => {
    expect(smokeScript).toContain("assertExplorerRowSelected");
    expect(smokeScript).toContain('aria-selected="true"');
    expect(smokeScript).toContain("Explorer row did not become selected");
  });

  it("asserts transaction-backed eigen frequency-window authoring", () => {
    expect(smokeScript).toContain("addEigenmodesAndEditFrequencyWindow");
    expect(smokeScript).toContain('selectOption("frequency_window")');
    expect(smokeScript).toContain("eigen_frequency_min");
    expect(smokeScript).toContain("eigen_frequency_max");
    expect(smokeScript).toContain("eigen_operator");
  });

  it("executes qualified K0 modal-demag authoring for CPU and CUDA and checks canonical export", () => {
    expect(smokeScript).toContain("CONTROL_ROOM_STUDY_AUTHORING_SMOKE_K0_ONLY");
    expect(smokeScript).toContain("authorK0ModalDemagForDevice");
    expect(smokeScript).toContain("periodic_airbox_k0");
    expect(smokeScript).toContain("/v2/sessions/current/meshing/meshes/shared-domain/manifest");
    expect(smokeScript).toContain("/v2/sessions/current/meshing/mesh/periodic_pairs.v1");
    expect(smokeScript).toContain("/v2/sessions/current/model/script");
    expect(smokeScript).toContain("assertK0CanonicalPythonRoundTrip");
    expect(smokeScript).toContain('authorK0ModalDemagForDevice("cpu")');
    expect(smokeScript).toContain('authorK0ModalDemagForDevice("gpu")');
    expect(smokeScript).toContain("requested_backend");
    expect(smokeScript).toContain("execution_precision");
    expect(smokeScript).toContain("execution_mode");
  });

  it("retains the legacy full-smoke projected-gradient BB assertion", () => {
    expect(smokeScript).toContain(
      'throw new Error("FEM demag projected-gradient BB must be unavailable.")',
    );
    expect(smokeScript).toContain("if (!k0Only)");
  });

  it("asserts transaction-backed frequency-response response-map authoring", () => {
    expect(smokeScript).toContain(
      '[data-node-id="model:study:stages:stage:${stageId}:calculation-mode"]',
    );
    expect(smokeScript).toContain('selectOption("response_map")');
    expect(smokeScript).toContain("frequency_calculation_mode");
    expect(smokeScript).toContain(
      '[data-node-id="model:study:stages:stage:${stageId}:k-grid"]',
    );
  });

  it("asserts transaction-backed frequency-response advanced setup authoring", () => {
    expect(smokeScript).toContain("frequency_k_sampling");
    expect(smokeScript).toContain("frequency_values_hz");
    expect(smokeScript).toContain("frequency_observable");
    expect(smokeScript).toContain("frequency_include_demag");
    expect(smokeScript).toContain("frequency_magnetostatic_bc");
    expect(smokeScript).toContain(
      '[data-node-id="model:study:stages:stage:${stageId}:periodic-pairs"]',
    );
  });
});
