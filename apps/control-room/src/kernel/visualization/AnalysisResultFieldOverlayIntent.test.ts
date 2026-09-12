import { describe, expect, it } from "vitest";

import type {
  AnalysisResultFieldRef,
  FieldVectorResponseMetadata,
} from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
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
  resource_key: "data/fields/analysis%3Aeigen%3Asample-0001%3Amode-0002",
  status: "ready",
};

const topology = {
  domainGenerationId: "generation-1",
  meshId: "mesh:shared-domain",
  meshTopologyHash: "sha256:topology-v1",
  meshTopologyRevision: "41",
  pointCount: 2,
};

function validBinary(): DecodedFieldVector {
  return {
    dtype: "float64",
    domainGenerationId: "generation-1",
    formatVersion: 3,
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
    expect(
      validateAnalysisResultFieldOverlayBinary(metadata, validBinary(), topology),
    ).toMatchObject({ complex: { componentCount: 3, pointCount: 2 } });
  });

  it("requires a self-consistent binary response without conflating transport and source revisions", () => {
    const intent = createAnalysisResultFieldOverlayIntent(selection, fieldRef)!;
    const responseMetadata: FieldVectorResponseMetadata = {
      component: "full",
      domainGenerationId: "generation-1",
      encoding: "FMVP;version=3",
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
});
