import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MESHING_PERIODIC_PAIRS_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_SCRIPT_PATH,
} from "@/kernel/api/apiPaths";

const smokeScript = readFileSync(
  new URL("../../../../scripts/smoke-study-authoring-ui.mjs", import.meta.url),
  "utf8",
);

describe("study authoring smoke script", () => {
  it("asserts the current run-scoped driven result workflow", () => {
    expect(smokeScript).toContain("results:run:study-authoring-smoke-run");
    expect(smokeScript).toContain(
      '[data-inspector-surface="frequency-response-sweep"]',
    );
    expect(smokeScript).toContain("Driven Response Sweep Control");
    expect(smokeScript).toContain("Driven Response Chart");
    expect(smokeScript).not.toContain('data-node-id="results:root"');
    expect(smokeScript).not.toContain("results:frequency-domain:fmr");
  });

  it("keeps modal visualization coverage in the dedicated inspector smoke", () => {
    expect(smokeScript).not.toContain("verifyFrequencyDomainModalResults");
    expect(smokeScript).toContain("assertStableViewport3DCanvas");
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
    expect(smokeScript).toContain(MESHING_SHARED_DOMAIN_MANIFEST_PATH);
    expect(smokeScript).toContain(MESHING_PERIODIC_PAIRS_PATH);
    expect(smokeScript).toContain(MODEL_SCRIPT_PATH);
    expect(smokeScript).toContain("assertK0CanonicalPythonRoundTrip");
    expect(smokeScript).toContain('authorK0ModalDemagForDevice("cpu")');
    expect(smokeScript).toContain('authorK0ModalDemagForDevice("gpu")');
    expect(smokeScript).toContain("requested_backend");
    expect(smokeScript).toContain("execution_precision");
    expect(smokeScript).toContain("execution_mode");
  });

  it("retains the current full-smoke projected-gradient BB availability assertions", () => {
    expect(smokeScript).toContain(
      "FEM demag projected-gradient BB must be available when advertised by runtime capabilities.",
    );
    expect(smokeScript).toContain(
      "FEM demag projected-gradient BB must not retain a stale quarantine reason when available.",
    );
    expect(smokeScript).not.toContain(
      "FEM demag projected-gradient BB must be unavailable.",
    );
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

  it("asserts automatic sinc sampling diagnostics and Python literals", () => {
    expect(smokeScript).toContain('selectOption("auto_sinc_cutoff")');
    expect(smokeScript).toContain('"6.5 GHz"');
    expect(smokeScript).toContain('"76.92 ps"');
    expect(smokeScript).toContain("boundingBox()");
    expect(smokeScript).toContain("assertMeasurableLayout(");
    expect(smokeScript).toContain('tableautosave("auto"');
    expect(smokeScript).toContain('every="auto"');
  });
});
