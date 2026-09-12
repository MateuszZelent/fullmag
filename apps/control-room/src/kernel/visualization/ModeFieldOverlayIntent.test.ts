import { describe, expect, it } from "vitest";

import type { FrequencyDomainFieldResource } from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
import type { SelectionRef } from "../selection/selectionTypes";

import {
  createModeFieldOverlayIntent,
  resolveModeFieldOverlayMetadata,
  validateModeFieldOverlayBinary,
} from "./ModeFieldOverlayIntent";

const selection: Extract<SelectionRef, { type: "frequency-domain" }> = {
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
};

const metadata: FrequencyDomainFieldResource = {
  artifact_path: "eigen/modes/sample_0000_mode_0001.field.v1.json",
  available_views: [
    "complex",
    "real",
    "imag",
    "abs",
    "amplitude",
    "phase",
    "phase_rotated_real",
  ],
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

const topology = {
  domainGenerationId: "domain-v7",
  meshTopologyHash: "topology-hash-v4",
  meshTopologyRevision: "topology-v4",
  pointCount: 2,
};

function validBinary(): DecodedFieldVector {
  return {
    dtype: "float64",
    domainGenerationId: "domain-v7",
    formatVersion: 3,
    grid: [1, 1, 2],
    indexing: "full_domain",
    meshTopologyHash: "topology-hash-v4",
    meshTopologyRevision: "topology-v4",
    nComp: 6,
    pointCount: 2,
    quantityId: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
    valueCount: 12,
    values: new Float64Array(12).fill(0.25),
  };
}

describe("ModeFieldOverlayIntent", () => {
  it("creates an immutable canonical mode intent from stable SelectionRef identity", () => {
    const intent = createModeFieldOverlayIntent(selection);

    expect(intent).toMatchObject({
      artifactRevision: "sha256:artifact-v1",
      fieldId: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
      modeId: "mode-1",
      sampleId: "sample-k0",
    });
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it("accepts only canonical ready global XYZ complex field metadata", () => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(resolveModeFieldOverlayMetadata(intent, metadata, "sha256:field-v1")).toMatchObject({
      defaultPhaseRad: 0,
      fieldId: selection.fieldId,
      payloadValueCount: 12,
      resourceRevision: "sha256:field-v1",
    });
  });

  it.each([
    ["tangent basis", { ...metadata, component_basis: "local_tangent_frame" }],
    ["two components", { ...metadata, component_count: 2 }],
    ["non-finite default phase", { ...metadata, default_phase_rad: Number.NaN }],
    ["incomplete complex layout", { ...metadata, binary_layout: null }],
  ])("fails closed for %s", (_label, invalidMetadata) => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(
      resolveModeFieldOverlayMetadata(intent, invalidMetadata, "sha256:field-v1"),
    ).toBeNull();
  });

  it("admits a binary field only when its complex XYZ shape and topology binding match metadata", () => {
    const intent = createModeFieldOverlayIntent(selection)!;
    const resolved = resolveModeFieldOverlayMetadata(
      intent,
      metadata,
      "sha256:field-v1",
    )!;

    expect(validateModeFieldOverlayBinary(resolved, validBinary(), topology)).toMatchObject({
      complex: {
        componentCount: 3,
        dtype: "complex128",
        pointCount: 2,
      },
      phasorAmplitudeMax: expect.any(Number),
    });
    expect(
      validateModeFieldOverlayBinary(
        resolved,
        {
          ...validBinary(),
          nComp: 4,
          valueCount: 8,
          values: new Float64Array(8),
        },
        topology,
      ),
    ).toBeNull();
  });

  it("fails closed for stale topology, invalid shape, or non-finite binary values", () => {
    const intent = createModeFieldOverlayIntent(selection)!;
    const resolved = resolveModeFieldOverlayMetadata(
      intent,
      metadata,
      "sha256:field-v1",
    )!;

    expect(
      validateModeFieldOverlayBinary(resolved, validBinary(), {
        ...topology,
        meshTopologyRevision: "topology-v5",
      }),
    ).toBeNull();
    expect(
      validateModeFieldOverlayBinary(
        resolved,
        { ...validBinary(), grid: [1, 1, 3] },
        topology,
      ),
    ).toBeNull();
    const nonFinite = validBinary();
    nonFinite.values[5] = Number.NaN;
    expect(validateModeFieldOverlayBinary(resolved, nonFinite, topology)).toBeNull();
  });
});
