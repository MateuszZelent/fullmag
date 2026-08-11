import { describe, expect, it } from "vitest";

import type { FrequencyDomainFieldResource } from "../api/apiTypes";
import { createModeFieldOverlayIntent } from "../visualization/ModeFieldOverlayIntent";
import {
  resolveModeFieldOverlayMetadataRevision,
  resolveModeFieldOverlayResource,
} from "./modeFieldOverlayResources";

const intent = createModeFieldOverlayIntent({
  analysisRunId: "run-k0",
  analysisStageId: "stage-eigen",
  artifactRevision: "sha256:artifact-v1",
  fieldId: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
  kind: "results.eigen.mode",
  modeId: "mode-1",
  modeIndex: 1,
  nodeId: "results:eigen:sample-k0:mode-1",
  sampleId: "sample-k0",
  sampleIndex: 0,
  type: "frequency-domain",
})!;

const metadata: FrequencyDomainFieldResource = {
  artifact_path: "eigen/modes/sample_0000_mode_0001.field.v1.json",
  available_views: ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
  binary_layout: "complex_f64_pairs_little_endian",
  complex_pair_count: 6,
  component_basis: "global_xyz",
  component_count: 3,
  components: ["x", "y", "z"],
  default_phase_rad: 0,
  default_view: "phase_rotated_real",
  field_id: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
  payload_encoding: "f64_interleaved_real_imag_xyz",
  payload_value_count: 12,
  quantity: "delta_m",
  resource_key: "data/fields/analysis%3Aeigen%3Asample-k0%3Amode-1%3Adelta_m_xyz",
  schema_version: "frequency_domain_mode_field.v1",
  source_family: "analysis/eigen",
  status: "ready",
  value_kind: "complex_spatial_vector",
};

describe("mode field overlay resource", () => {
  it("does not expose a binary request until metadata is verified against the active intent", () => {
    expect(
      resolveModeFieldOverlayResource(intent, {
        data: metadata,
        error: null,
        revision: "sha256:field-v1",
        status: "ready",
      }),
    ).toMatchObject({
      binaryResourceKey: "data/fields/analysis%3Aeigen%3Asample-k0%3Amode-1%3Adelta_m_xyz",
      metadataStatus: "ready",
      status: "ready",
    });
  });

  it("keeps a malformed or stale metadata payload fail-closed", () => {
    expect(
      resolveModeFieldOverlayResource(intent, {
        data: { ...metadata, component_basis: "local_tangent_frame" },
        error: null,
        revision: "sha256:field-v1",
        status: "ready",
      }),
    ).toMatchObject({ binaryResourceKey: null, status: "error" });
  });

  it("changes the field build revision when an artifact revision changes at the same metadata path", () => {
    const nextIntent = createModeFieldOverlayIntent({
      analysisRunId: "run-k0",
      analysisStageId: "stage-eigen",
      artifactRevision: "sha256:artifact-v2",
      fieldId: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
      kind: "results.eigen.mode",
      modeId: "mode-1",
      modeIndex: 1,
      nodeId: "results:eigen:sample-k0:mode-1",
      sampleId: "sample-k0",
      sampleIndex: 0,
      type: "frequency-domain",
    })!;

    const first = resolveModeFieldOverlayResource(intent, {
      data: metadata,
      error: null,
      revision: resolveModeFieldOverlayMetadataRevision(intent, metadata),
      status: "ready",
    });
    const next = resolveModeFieldOverlayResource(nextIntent, {
      data: metadata,
      error: null,
      revision: resolveModeFieldOverlayMetadataRevision(nextIntent, metadata),
      status: "ready",
    });

    expect(first.metadata?.resourceRevision).toContain("sha256:artifact-v1");
    expect(next.metadata?.resourceRevision).toContain("sha256:artifact-v2");
    expect(next.metadata?.resourceRevision).not.toBe(first.metadata?.resourceRevision);
  });
});
