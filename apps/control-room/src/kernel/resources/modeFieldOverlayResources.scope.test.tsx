import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { createModeFieldOverlayIntent } from "@/kernel/visualization/ModeFieldOverlayIntent";
import { useModeFieldOverlayIntentResource } from "./modeFieldOverlayResources";

const fixture = vi.hoisted(() => {
  const metadata = vi.fn();
  const vector = vi.fn();
  return {
    identity: { sessionId: "archive&1", sessionEpoch: "epoch=α", requestScopeEpoch: "incarnation%2" },
    metadata,
    vector,
    // Production Kernel owns one stable API; recreating it on render retriggers
    // controller effects and tests a dependency loop instead of HTTP encoding.
    api: {
      analysis: { frequencyDomain: { eigenModeFieldMeta: metadata } },
      data: { fields: { vector } },
    },
  };
});
vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => ({ api: fixture.api }) }));
vi.mock("@/kernel/resources/useSessionStatus", () => ({ useSessionResourceIdentity: () => fixture.identity }));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({ useFrequencyDomainEigenModeFieldMetaResource: vi.fn() }));

const intent = createModeFieldOverlayIntent({
  analysisRunId: "run:archived", analysisStageId: "stage-001", artifactRevision: "sha256:artifact",
  fieldId: "analysis:eigen:sample-0000:mode-0000", modeId: "mode-zero", modeIndex: 0,
  sampleId: "sample-zero", sampleIndex: 0, nodeId: "mode-zero", kind: "results.eigen.mode", type: "frequency-domain",
})!;
const topology = { domainGenerationId: "geometry", meshTopologyHash: "mesh", meshTopologyRevision: "1", pointCount: 1 };
const expectedScope = "session=archive%261&epoch=epoch%3D%CE%B1&request_scope_epoch=incarnation%252";

describe("mode overlay HTTP session scope", () => {
  afterEach(() => vi.resetAllMocks());
  it("passes canonical encoded scope to metadata and binary requests, never the NUL cache key", async () => {
    const { restore: restoreDom } = installSimulationPreparationTestDom();
    const container = document.createElement("div");
    const root = createRoot(container);
    fixture.metadata.mockImplementation(async (_sample, _mode, options) => {
      expect(options.sessionScopeKey).toBe(expectedScope);
      expect(new Headers({ "x-fullmag-session-scope": options.sessionScopeKey }).get("x-fullmag-session-scope")).toBe(expectedScope);
      return {
        schema_version: "frequency_domain_mode_field.v1", status: "ready", source_family: "analysis/eigen", quantity: "delta_m",
        field_id: intent.fieldId, artifact_path: "eigen/mode_fields/sample_0000/mode_0000/vector.bin",
        value_kind: "complex_spatial_vector", component_basis: "global_xyz", component_count: 3, components: ["x", "y", "z"],
        payload_encoding: "f64_interleaved_real_imag_xyz", binary_layout: "complex_f64_pairs_little_endian",
        complex_pair_count: 3, payload_value_count: 6, default_phase_rad: 0, available_views: ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
        default_view: "phase_rotated_real", resource_key: "data/fields/mode", revision: "sha256:field", content_digest: "sha256:field",
      };
    });
    fixture.vector.mockImplementation(async (_field, _query, options) => {
      expect(options.sessionScopeKey).toBe(expectedScope);
      expect(options.sessionScopeKey).not.toContain("\0");
      expect(new Headers({ "x-fullmag-session-scope": options.sessionScopeKey }).get("x-fullmag-session-scope")).toBe(expectedScope);
      // This regression ends at the transport boundary, before FMVP decoding.
      return { status: "missing" };
    });
    function Probe() { useModeFieldOverlayIntentResource({ intent, topology }); return null; }
    try {
      await act(async () => { root.render(createElement(Probe)); });
      expect(fixture.metadata).toHaveBeenCalledTimes(1);
      expect(fixture.vector).toHaveBeenCalledTimes(1);
      const metadataOptions = fixture.metadata.mock.calls[0]![2];
      const binaryOptions = fixture.vector.mock.calls[0]![2];
      expect(binaryOptions.signal).toBe(metadataOptions.signal);
    } finally {
      await act(async () => root.unmount());
      restoreDom();
    }
  });
});
