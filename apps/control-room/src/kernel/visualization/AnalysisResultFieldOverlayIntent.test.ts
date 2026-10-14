import { describe, expect, it } from "vitest";

import type {
  AnalysisResultFieldRef,
  FieldVectorQuery,
  FieldVectorResponseMetadata,
} from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
import { fieldVectorResourceKey } from "../api/fieldQueryIdentity";
import type { AnalysisResultSelectionRef } from "@/shared/domain/analysis/results";

import {
  analysisResultFieldOverlayAdapter,
  createAnalysisResultFieldOverlayIntent,
  resolveAnalysisResultFieldOverlayMetadata,
  validateAnalysisResultFieldResponseMetadata,
  validateAnalysisResultFieldOverlayBinary,
} from "./AnalysisResultFieldOverlayIntent";

const selection: AnalysisResultSelectionRef = {
  datasetId: "result:run-1:stage-1:modal-eigen-field-sweep",
  datasetRevision: "sha256:dataset-v1",
  fieldId: "analysis:eigen:sample-0001:mode-0002",
  fieldRevision: "sha256:field-v1",
  focus: "item",
  itemId: "mode-0002",
  itemKind: "eigen_mode",
  kind: "analysis.result",
  nodeId: "analysis-result:run-1:item:mode-0002",
  runId: "run-1",
  sampleId: "sample-0001",
  stageId: "stage-1",
  type: "analysis-result",
};

const fieldRef: AnalysisResultFieldRef = {
  field_id: "analysis:eigen:sample-0001:mode-0002",
  field_revision: "sha256:field-v1",
  mesh_ref: {
    mesh_id: "mesh:shared-domain",
    mesh_revision: "41",
    topology_fingerprint: "sha256:topology-v1",
  },
  quantity_id: "m",
  representation: "complex-vector-xyz",
  resource_key: fieldVectorResourceKey("analysis:eigen:sample-0001:mode-0002", {
    component: "full",
    scope_kind: "full",
    view: "complex",
  }),
  status: "ready",
};

const topology = {
  domainGenerationId: "generation-1",
  meshId: "mesh:shared-domain",
  meshTopologyHash: "sha256:topology-v1",
  meshTopologyRevision: "41",
  pointCount: 2,
};

function validBinary(formatVersion: 3 | 5 = 3): DecodedFieldVector {
  return {
    dtype: "float64",
    domainGenerationId: "generation-1",
    formatVersion,
    grid: [1, 1, 2],
    indexing: "full_domain",
    meshTopologyHash: "sha256:topology-v1",
    meshTopologyRevision: "41",
    nComp: 6,
    pointCount: 2,
    quantityId: "analysis:eigen:sample-0001:mode-0002",
    valueCount: 12,
    values: new Float64Array(12).fill(0.25),
  };
}

describe("AnalysisResultFieldOverlayIntent", () => {
  it.each([
    ["eigen_mode", "eigen-mode", "analysis.eigen.plot-mode-3d"],
    [
      "driven_frequency_point",
      "frequency-response",
      "analysis.frequency-response.plot-response-field-3d",
    ],
    [
      "spectral_feature",
      "time-domain-response",
      "analysis.time-domain.plot-response-field-3d",
    ],
    [
      "dsf_point",
      "time-domain-response",
      "analysis.time-domain.plot-response-field-3d",
    ],
  ] as const)("resolves the %s field source through the adapter registry", (itemKind, source, plotCommandId) => {
    expect(analysisResultFieldOverlayAdapter(itemKind)).toMatchObject({
      itemKind,
      plotCommandId,
      source,
    });
  });

  it("creates an immutable field intent from dataset, item, field, and mesh identity", () => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, fieldRef);

    expect(intent).toMatchObject({
      datasetId: selection.datasetId,
      datasetRevision: selection.datasetRevision,
      fieldId: fieldRef.field_id,
      fieldRevision: fieldRef.field_revision,
      itemId: selection.itemId,
      sampleId: selection.sampleId,
      source: "eigen-mode",
    });
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it("fails closed when the result is spectrum-only or has no immutable mesh reference", () => {
    expect(
      createAnalysisResultFieldOverlayIntent(selection, {
        ...fieldRef,
        mesh_ref: null,
        status: "ready",
      }),
    ).toBeNull();
    expect(
      createAnalysisResultFieldOverlayIntent(selection, {
        ...fieldRef,
        status: "spectrum_only",
      }),
    ).toBeNull();
    expect(createAnalysisResultFieldOverlayIntent(selection, null)).toBeNull();
  });

  it("requires the selected stable field identity to match the item field reference", () => {
    expect(
      createAnalysisResultFieldOverlayIntent(
        { ...selection, fieldRevision: "sha256:other-field" },
        fieldRef,
      ),
    ).toBeNull();
    expect(
      createAnalysisResultFieldOverlayIntent(
        { ...selection, fieldId: "analysis:eigen:other-field" },
        fieldRef,
      ),
    ).toBeNull();
  });

  it("resolves typed metadata and accepts only a matching complex XYZ binary payload", () => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, fieldRef)!;
    const metadata = resolveAnalysisResultFieldOverlayMetadata(intent)!;

    expect(metadata).toMatchObject({
      fieldId: fieldRef.field_id,
      resourceRevision: fieldRef.field_revision,
      binaryQuery: { component: "full", scope_kind: "full", view: "complex" },
    });
    expect(metadata.binaryQuery.expected_artifact_generation_id).toBeUndefined();
    expect(
      validateAnalysisResultFieldOverlayBinary(metadata, validBinary(), topology),
    ).toMatchObject({ complex: { componentCount: 3, pointCount: 2 } });
    expect(
      validateAnalysisResultFieldOverlayBinary(metadata, validBinary(5), topology),
    ).toMatchObject({ complex: { componentCount: 3, pointCount: 2 } });
  });

  it("preserves the committed artifact generation and other vector identity parameters", () => {
    const expectedQuery: FieldVectorQuery = {
      component: "full",
      expected_artifact_generation_id: "publication-14",
      expected_carrier_revision: "carrier-revision-8",
      expected_generation_id: "domain-generation-5",
      scope_kind: "full",
      view: "complex",
    };
    const resourceKey = fieldVectorResourceKey(fieldRef.field_id, expectedQuery);
    const intent = createAnalysisResultFieldOverlayIntent(selection, {
      ...fieldRef,
      resource_key: resourceKey,
    })!;
    const metadata = resolveAnalysisResultFieldOverlayMetadata(intent);

    expect(metadata).not.toBeNull();
    expect(metadata?.binaryQuery).toMatchObject(expectedQuery);
    expect(
      fieldVectorResourceKey(metadata!.fieldId, metadata!.binaryQuery),
    ).toBe(resourceKey);
  });

  it("normalizes a canonical phase-rotated result link to the full complex overlay query", () => {
    const resourceKey = fieldVectorResourceKey(fieldRef.field_id, {
      component: "magnitude",
      expected_artifact_generation_id: "publication-14",
      expected_generation_id: "domain-generation-5",
      phase_rad: 0.375,
      scope_kind: "full",
      view: "phase_rotated_real",
    });
    const intent = createAnalysisResultFieldOverlayIntent(selection, {
      ...fieldRef,
      resource_key: resourceKey,
    })!;
    const metadata = resolveAnalysisResultFieldOverlayMetadata(intent);

    expect(metadata?.binaryQuery).toMatchObject({
      component: "full",
      expected_artifact_generation_id: "publication-14",
      expected_generation_id: "domain-generation-5",
      phase_rad: 0.375,
      scope_kind: "full",
      view: "complex",
    });
  });

  it.each([
    [
      "a mismatched field id",
      fieldVectorResourceKey("analysis:eigen:other-field", {
        component: "full",
        scope_kind: "full",
        view: "complex",
      }),
    ],
    [
      "a duplicate generation parameter",
      `${fieldVectorResourceKey(fieldRef.field_id, {
        component: "full",
        expected_artifact_generation_id: "publication-14",
        scope_kind: "full",
        view: "complex",
      })}&expected_artifact_generation_id=publication-15`,
    ],
    [
      "a foreign origin",
      `https://foreign.invalid${fieldVectorResourceKey(fieldRef.field_id)}`,
    ],
    ["a URI fragment", `${fieldVectorResourceKey(fieldRef.field_id)}#fragment`],
    [
      "a non-vector path",
      "data/fields/analysis%3Aeigen%3Asample-0001%3Amode-0002",
    ],
    [
      "an unsupported component",
      fieldVectorResourceKey(fieldRef.field_id, {
        component: "not-a-component",
        scope_kind: "full",
        view: "complex",
      }),
    ],
    [
      "a non-full scope",
      fieldVectorResourceKey(fieldRef.field_id, {
        component: "full",
        scope_id: "film",
        scope_kind: "object",
        view: "complex",
      }),
    ],
    [
      "an unsupported view",
      fieldVectorResourceKey(fieldRef.field_id, {
        component: "full",
        scope_kind: "full",
        view: "phasor",
      }),
    ],
  ])("rejects a field resource key with %s", (_label, resourceKey) => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, {
      ...fieldRef,
      resource_key: resourceKey,
    })!;

    expect(resolveAnalysisResultFieldOverlayMetadata(intent)).toBeNull();
  });

  it("requires a self-consistent binary response without conflating transport and source revisions", () => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, fieldRef)!;
    const responseMetadata: FieldVectorResponseMetadata = {
      component: "full",
      domainGenerationId: "generation-1",
      encoding: "FMVP;version=5",
      fieldIndexing: "full_domain",
      fieldRevision: "transport-revision-41",
      identityIssues: [],
      meshTopologyHash: "sha256:topology-v1",
      nComp: 6,
      nodeIndexCount: 0,
      pointCount: 2,
      quantityId: fieldRef.field_id,
      scopeId: null,
      scopeKind: "full",
      snapshotId: null,
      valueCount: 12,
    };

    expect(
      validateAnalysisResultFieldResponseMetadata(intent, responseMetadata),
    ).toBe(true);
    const explicitNodeMetadata = {
      ...responseMetadata,
      fieldIndexing: "explicit_node_indices",
      nodeIndexCount: responseMetadata.pointCount,
    };
    expect(
      validateAnalysisResultFieldResponseMetadata(intent, explicitNodeMetadata),
    ).toBe(true);
    expect(
      validateAnalysisResultFieldResponseMetadata(intent, {
        ...explicitNodeMetadata,
        encoding: "FMVP;version=3",
      }),
    ).toBe(false);
    expect(
      validateAnalysisResultFieldResponseMetadata(intent, {
        ...explicitNodeMetadata,
        nodeIndexCount: 1,
      }),
    ).toBe(false);
    expect(
      validateAnalysisResultFieldResponseMetadata(intent, {
        ...responseMetadata,
        encoding: "FMVP;version=3",
      }),
    ).toBe(true);
    expect(
      validateAnalysisResultFieldResponseMetadata(intent, {
        ...responseMetadata,
        quantityId: "m",
      }),
    ).toBe(false);
    expect(
      validateAnalysisResultFieldResponseMetadata(intent, {
        ...responseMetadata,
        identityIssues: [
          { field: "meshTopologyHash", headerValue: "wrong", payloadValue: "right" },
        ],
      }),
    ).toBe(false);

    const expectedArtifactGenerationId = "publication-14";
    const generatedIntent = createAnalysisResultFieldOverlayIntent(selection, {
      ...fieldRef,
      resource_key: fieldVectorResourceKey(fieldRef.field_id, {
        component: "full",
        expected_artifact_generation_id: expectedArtifactGenerationId,
        scope_kind: "full",
        view: "complex",
      }),
    })!;
    expect(
      validateAnalysisResultFieldResponseMetadata(generatedIntent, {
        ...responseMetadata,
        artifactGenerationId: expectedArtifactGenerationId,
      }),
    ).toBe(true);
    expect(
      validateAnalysisResultFieldResponseMetadata(generatedIntent, {
        ...responseMetadata,
        artifactGenerationId: "publication-stale",
      }),
    ).toBe(false);
    expect(
      validateAnalysisResultFieldResponseMetadata(generatedIntent, responseMetadata),
    ).toBe(false);
  });

  it.each([
    ["mesh id", { meshId: "mesh:other" }, {}],
    ["topology fingerprint", { meshTopologyHash: "sha256:other-topology" }, {}],
    ["mesh revision", { meshTopologyRevision: "42" }, {}],
    ["component basis", {}, { nComp: 3, valueCount: 6, values: new Float64Array(6) }],
  ])("rejects a binary payload with a mismatching %s", (_label, topologyPatch, binaryPatch) => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, fieldRef)!;
    const metadata = resolveAnalysisResultFieldOverlayMetadata(intent)!;

    expect(
      validateAnalysisResultFieldOverlayBinary(
        metadata,
        { ...validBinary(), ...binaryPatch },
        { ...topology, ...topologyPatch },
      ),
    ).toBeNull();
  });

  it("accepts FMVP v5 explicit nodes only with a valid map to the matching mesh", () => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, fieldRef)!;
    const metadata = resolveAnalysisResultFieldOverlayMetadata(intent)!;
    const sharedTopology = { ...topology, pointCount: 5 };
    const explicitField: DecodedFieldVector = {
      ...validBinary(5),
      grid: [2, 1, 1],
      indexing: "explicit_node_indices",
      nodeIndices: new Uint32Array([1, 3]),
    };

    const validated = validateAnalysisResultFieldOverlayBinary(
      metadata,
      explicitField,
      sharedTopology,
    );
    expect(validated?.binary.nodeIndices).toEqual(new Uint32Array([1, 3]));
    expect(validated?.complex.nodeIndices).toEqual(new Uint32Array([1, 3]));

    expect(
      validateAnalysisResultFieldOverlayBinary(
        metadata,
        { ...explicitField, formatVersion: 3 },
        sharedTopology,
      ),
    ).toBeNull();
    expect(
      validateAnalysisResultFieldOverlayBinary(
        metadata,
        { ...explicitField, nodeIndices: new Uint32Array([1, 5]) },
        sharedTopology,
      ),
    ).toBeNull();
    expect(
      validateAnalysisResultFieldOverlayBinary(
        metadata,
        { ...explicitField, nodeIndices: new Uint32Array([1]) },
        sharedTopology,
      ),
    ).toBeNull();
    expect(
      validateAnalysisResultFieldOverlayBinary(
        metadata,
        explicitField,
        { ...sharedTopology, meshTopologyHash: "sha256:other-topology" },
      ),
    ).toBeNull();
  });

  it("rejects an FMVP v5 no-topology sentinel for the full-domain overlay", () => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, fieldRef)!;
    const metadata = resolveAnalysisResultFieldOverlayMetadata(intent)!;

    expect(
      validateAnalysisResultFieldOverlayBinary(
        metadata,
        {
          ...validBinary(5),
          indexing: "legacy_count_only",
          meshTopologyHash: null,
          meshTopologyRevision: null,
        },
        topology,
      ),
    ).toBeNull();
  });
});
