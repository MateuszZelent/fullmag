import { describe, expect, it } from "vitest";

import type {
  FrequencyDomainFieldResource,
  FrequencyDomainJsonArtifactResource,
} from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
import type { SelectionRef } from "../selection/selectionTypes";

import {
  createModeFieldOverlayIntent,
  isEigenModeFrequencyDomainSelectionKind,
  resolveModeFieldOverlayMetadata,
  validateModeFieldOverlayBinary,
} from "./ModeFieldOverlayIntent";

const selection: Extract<SelectionRef, { type: "frequency-domain" }> = {
  analysisRunId: "run-k0",
  analysisStageId: "stage-eigen",
  artifactRevision: "sha256:artifact-v1",
  fieldId: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
  equilibriumId: "eq-gamma",
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

interface ModeArtifactOverrides {
  candidateEquilibriumId?: unknown;
  includeCandidateIdentity?: boolean;
  includePayloadEquilibriumId?: boolean;
  modeFieldId?: string;
  modeId?: string;
  payloadEquilibriumId?: unknown;
  sampleId?: string;
  rawModeIndex?: number;
  runId?: string;
  sampleIndex?: number;
  stageId?: string;
}

function modeArtifact(
  overrides: ModeArtifactOverrides = {},
): FrequencyDomainJsonArtifactResource {
  const hasPayloadEq = Object.prototype.hasOwnProperty.call(
    overrides,
    "payloadEquilibriumId",
  );
  const hasCandidateEq = Object.prototype.hasOwnProperty.call(
    overrides,
    "candidateEquilibriumId",
  );
  const payload: Record<string, unknown> = {
    mode_field_id: overrides.modeFieldId ?? selection.fieldId,
    mode_id: overrides.modeId ?? selection.modeId,
    raw_mode_index: overrides.rawModeIndex ?? selection.modeIndex,
    sample_id: overrides.sampleId ?? selection.sampleId,
    sample_index: overrides.sampleIndex ?? selection.sampleIndex,
    schema_version: "eigen_mode.v2",
  };
  if (overrides.includePayloadEquilibriumId !== false) {
    payload.equilibrium_artifact_sha256 = hasPayloadEq
      ? overrides.payloadEquilibriumId
      : "eq-gamma";
  }
  if (overrides.includeCandidateIdentity !== false) {
    payload.candidate_identity = {
      equilibrium_artifact_sha256: hasCandidateEq
        ? overrides.candidateEquilibriumId
        : "eq-gamma",
      schema_version: "frequency_domain_candidate_identity.v1",
      source_identity: {},
    };
  }
  return {
    artifact_path: "eigen/mode.v1.json",
    content_digest: "sha256:mode-artifact",
    payload: payload as unknown as FrequencyDomainJsonArtifactResource["payload"],
    resource_key: "analysis/frequency-domain/eigen/mode/0/1",
    revision: "sha256:mode-artifact",
    run_id: overrides.runId ?? selection.analysisRunId,
    schema_version: "frequency_domain_eigen_artifact.v1",
    stage_id: overrides.stageId ?? selection.analysisStageId,
    status: "ready",
  };
}

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
      equilibriumId: "eq-gamma",
      modeId: "mode-1",
      sampleId: "sample-k0",
    });
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it.each([
    "results.dispersion.modal.mode_at_k",
    "results.resonance.modal.mode",
  ])("creates a mode intent for the published %s route", (kind) => {
    const intent = createModeFieldOverlayIntent({ ...selection, kind });

    expect(intent).toMatchObject({
      analysisRunId: selection.analysisRunId,
      analysisStageId: selection.analysisStageId,
      artifactRevision: selection.artifactRevision,
      fieldId: selection.fieldId,
      equilibriumId: selection.equilibriumId,
      modeId: selection.modeId,
      nodeId: selection.nodeId,
      sampleId: selection.sampleId,
    });
    expect(isEigenModeFrequencyDomainSelectionKind(kind)).toBe(true);
  });

  it("does not treat modal result groups as a selected eigen mode", () => {
    expect(isEigenModeFrequencyDomainSelectionKind("results.dispersion.modal.modes_at_k")).toBe(false);
    expect(isEigenModeFrequencyDomainSelectionKind("results.resonance.modal.modes")).toBe(false);
    expect(isEigenModeFrequencyDomainSelectionKind("results.eigen.root")).toBe(false);
  });

  it("accepts canonical field metadata bound to the exact owned mode artifact", () => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(
      resolveModeFieldOverlayMetadata(
        intent,
        metadata,
        "sha256:field-v1",
        modeArtifact(),
      ),
    ).toMatchObject({
      defaultPhaseRad: 0,
      fieldId: selection.fieldId,
      payloadValueCount: 12,
      resourceRevision: "sha256:field-v1",
    });
  });

  it("rejects an owned mode artifact bound to another sample equilibrium", () => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(
      resolveModeFieldOverlayMetadata(
        intent,
        metadata,
        "sha256:field-v1",
        modeArtifact({ candidateEquilibriumId: "eq-nonzero-k" }),
      ),
    ).toBeNull();
  });

  it("fails closed when an Eq-bound selection has no owned mode artifact", () => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(
      resolveModeFieldOverlayMetadata(intent, metadata, "sha256:field-v1"),
    ).toBeNull();
  });

  it("fails closed when the owned mode artifact omits its sample Eq", () => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(
      resolveModeFieldOverlayMetadata(
        intent,
        metadata,
        "sha256:field-v1",
        modeArtifact({ includePayloadEquilibriumId: false }),
      ),
    ).toBeNull();
  });

  it("rejects a malformed duplicate Eq property even when the owned Eq matches", () => {
    const intent = createModeFieldOverlayIntent(selection)!;
    const valid = modeArtifact();
    const validPayload = valid.payload as Record<string, unknown>;
    const malformedDuplicate = {
      ...valid,
      equilibrium_artifact_sha256: "eq-gamma",
      payload: { ...validPayload, equilibrium_artifact_sha256: null },
    } as FrequencyDomainJsonArtifactResource;

    expect(
      resolveModeFieldOverlayMetadata(
        intent,
        metadata,
        "sha256:field-v1",
        malformedDuplicate,
      ),
    ).toBeNull();
  });

  it("rejects a non-null candidate identity without Eq beside a valid duplicate", () => {
    const intent = createModeFieldOverlayIntent(selection)!;
    const valid = modeArtifact();
    const malformedDuplicate = {
      ...valid,
      candidate_identity: {},
    } as FrequencyDomainJsonArtifactResource;

    expect(
      resolveModeFieldOverlayMetadata(
        intent,
        metadata,
        "sha256:field-v1",
        malformedDuplicate,
      ),
    ).toBeNull();
  });

  it("rejects malformed Eq-only mode artifacts for a historical selection", () => {
    const historicalIntent = createModeFieldOverlayIntent({
      ...selection,
      equilibriumId: undefined,
    })!;

    expect(
      resolveModeFieldOverlayMetadata(
        historicalIntent,
        metadata,
        "sha256:field-v1",
        modeArtifact({ payloadEquilibriumId: null, candidateEquilibriumId: null }),
      ),
    ).toBeNull();
  });

  it("keeps historical Eq-less selections with Eq-less mode artifacts", () => {
    const historicalIntent = createModeFieldOverlayIntent({
      ...selection,
      equilibriumId: undefined,
    })!;

    expect(historicalIntent).not.toHaveProperty("equilibriumId");
    expect(
      resolveModeFieldOverlayMetadata(
        historicalIntent,
        metadata,
        "sha256:field-v1",
        modeArtifact({
          includeCandidateIdentity: false,
          includePayloadEquilibriumId: false,
        }),
      ),
    ).not.toBeNull();
    expect(
      resolveModeFieldOverlayMetadata(
        historicalIntent,
        metadata,
        "sha256:field-v1",
      ),
    ).not.toBeNull();
  });

  it.each([
    ["run", { runId: "foreign-run" }],
    ["stage", { stageId: "foreign-stage" }],
    ["sample index", { sampleIndex: 2 }],
    ["sample ID", { sampleId: "different-sample" }],
    ["raw mode index", { rawModeIndex: 2 }],
    ["mode ID", { modeId: "different-mode" }],
    ["mode field ID", { modeFieldId: "field-from-another-mode" }],
  ])("rejects an owned mode artifact with a different %s", (_label, overrides) => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(
      resolveModeFieldOverlayMetadata(
        intent,
        metadata,
        "sha256:field-v1",
        modeArtifact(overrides),
      ),
    ).toBeNull();
  });

  it.each([
    ["tangent basis", { ...metadata, component_basis: "local_tangent_frame" }],
    ["two components", { ...metadata, component_count: 2 }],
    ["non-finite default phase", { ...metadata, default_phase_rad: Number.NaN }],
    ["incomplete complex layout", { ...metadata, binary_layout: null }],
  ])("fails closed for %s", (_label, invalidMetadata) => {
    const intent = createModeFieldOverlayIntent(selection)!;

    expect(
      resolveModeFieldOverlayMetadata(
        intent,
        invalidMetadata,
        "sha256:field-v1",
        modeArtifact(),
      ),
    ).toBeNull();
  });

  it("admits a binary field only when its complex XYZ shape and topology binding match metadata", () => {
    const intent = createModeFieldOverlayIntent(selection)!;
    const resolved = resolveModeFieldOverlayMetadata(
      intent,
      metadata,
      "sha256:field-v1",
      modeArtifact(),
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
      modeArtifact(),
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
