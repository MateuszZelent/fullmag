import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { createModeFieldOverlayIntent } from "@/kernel/visualization/ModeFieldOverlayIntent";
import {
  useModeFieldOverlayIntentResource,
  useModeFieldOverlayResource,
} from "./modeFieldOverlayResources";

const fixture = vi.hoisted(() => {
  const metadata = vi.fn();
  const modeArtifact = vi.fn();
  const vector = vi.fn();
  const fieldMetadataResource = vi.fn();
  const modeArtifactResource = vi.fn();
  return {
    identity: { sessionId: "archive&1", sessionEpoch: "epoch=α", requestScopeEpoch: "incarnation%2" },
    metadata,
    modeArtifact,
    vector,
    fieldMetadataResource,
    modeArtifactResource,
    // Production Kernel owns one stable API; recreating it on render retriggers
    // controller effects and tests a dependency loop instead of HTTP encoding.
    api: {
      analysis: { frequencyDomain: { eigenMode: modeArtifact, eigenModeFieldMeta: metadata } },
      data: { fields: { vector } },
    },
  };
});
vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => ({ api: fixture.api }) }));
vi.mock("@/kernel/resources/useSessionStatus", () => ({ useSessionResourceIdentity: () => fixture.identity }));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainEigenModeFieldMetaResource: fixture.fieldMetadataResource,
  useFrequencyDomainEigenModeResource: fixture.modeArtifactResource,
}));

const intent = createModeFieldOverlayIntent({
  analysisRunId: "run:archived", analysisStageId: "stage-001", artifactRevision: "sha256:artifact",
  fieldId: "analysis:eigen:sample-0000:mode-0000", equilibriumId: "eq-sample-zero", modeId: "mode-zero", modeIndex: 0,
  sampleId: "sample-zero", sampleIndex: 0, nodeId: "mode-zero", kind: "results.eigen.mode", type: "frequency-domain",
})!;
function modeArtifact() {
  return {
    artifact_path: "eigen/mode-0000.json",
    content_digest: "sha256:mode-artifact",
    resource_key: "analysis/frequency-domain/eigen/modes/0/0",
    revision: "sha256:mode-artifact",
    run_id: "run:archived",
    schema_version: "frequency_domain_eigen_artifact.v1",
    stage_id: "stage-001",
    status: "ready",
    payload: {
      candidate_identity: {
        equilibrium_artifact_sha256: "eq-sample-zero",
        schema_version: "frequency_domain_candidate_identity.v1",
        source_identity: {},
      },
      equilibrium_artifact_sha256: "eq-sample-zero",
      mode_field_id: "analysis:eigen:sample-0000:mode-0000",
      raw_mode_index: 0,
      sample_index: 0,
      schema_version: "eigen_mode.v2",
    },
  };
}

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
    fixture.modeArtifact.mockImplementation(async (_sample, _mode, options) => {
      expect(options.sessionScopeKey).toBe(expectedScope);
      expect(new Headers({ "x-fullmag-session-scope": options.sessionScopeKey }).get("x-fullmag-session-scope")).toBe(expectedScope);
      return modeArtifact();
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
      expect(fixture.modeArtifact).toHaveBeenCalledTimes(1);
      expect(fixture.vector).toHaveBeenCalledTimes(1);
      const metadataOptions = fixture.metadata.mock.calls[0]![2];
      const modeArtifactOptions = fixture.modeArtifact.mock.calls[0]![2];
      const binaryOptions = fixture.vector.mock.calls[0]![2];
      expect(modeArtifactOptions.signal).toBe(metadataOptions.signal);
      expect(binaryOptions.signal).toBe(metadataOptions.signal);
    } finally {
      await act(async () => root.unmount());
      restoreDom();
    }
  });

  it("uses the owned mode resource cache for Eq-bound field metadata", async () => {
    const { restore: restoreDom } = installSimulationPreparationTestDom();
    const container = document.createElement("div");
    const root = createRoot(container);
    fixture.modeArtifactResource.mockReturnValue({
      data: modeArtifact(),
      error: null,
      revision: "sha256:mode-artifact",
      status: "ready",
    });
    fixture.fieldMetadataResource.mockReturnValue({
      data: {
        schema_version: "frequency_domain_mode_field.v1",
        status: "ready",
        source_family: "analysis/eigen",
        quantity: "delta_m",
        field_id: intent.fieldId,
        artifact_path: "eigen/mode_fields/sample_0000/mode_0000/vector.bin",
        value_kind: "complex_spatial_vector",
        component_basis: "global_xyz",
        component_count: 3,
        components: ["x", "y", "z"],
        payload_encoding: "f64_interleaved_real_imag_xyz",
        binary_layout: "complex_f64_pairs_little_endian",
        complex_pair_count: 3,
        payload_value_count: 6,
        default_phase_rad: 0,
        available_views: ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
        default_view: "phase_rotated_real",
        resource_key: "data/fields/mode",
        revision: "sha256:field",
        content_digest: "sha256:field",
      },
      error: null,
      revision: "sha256:field",
      status: "ready",
    });
    let resolved: ReturnType<typeof useModeFieldOverlayResource> | null = null;
    function Probe() {
      resolved = useModeFieldOverlayResource(intent);
      return null;
    }
    try {
      await act(async () => { root.render(createElement(Probe)); });
      expect(fixture.modeArtifactResource).toHaveBeenCalledWith(0, 0, { enabled: true });
      expect(fixture.fieldMetadataResource).toHaveBeenCalledWith(0, 0, { enabled: true });
      expect(fixture.modeArtifact).not.toHaveBeenCalled();
      expect(resolved).toMatchObject({ status: "ready", metadata: { fieldId: intent.fieldId } });
    } finally {
      await act(async () => root.unmount());
      restoreDom();
    }
  });
});
