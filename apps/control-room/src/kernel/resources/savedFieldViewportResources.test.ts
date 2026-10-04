import { describe, expect, it } from "vitest";

import type {
  MaterializedDatasetResource,
  SavedFieldGeometryResource,
} from "../api/apiTypes";
import type { DecodedTopology } from "../api/codecs/types";
import type { DecodedSavedSupport } from "../api/codecs/savedSupportCodec";

import { resolveSavedFieldViewportEligibility } from "./savedFieldViewportResources";

function datasetFixture({
  componentCount = "3",
  dtype = "f64",
  quantityId = "m",
  totalBytes = dtype === "f32" ? "24" : "48",
  unit = "1",
}: {
  componentCount?: string;
  dtype?: "f32" | "f64";
  quantityId?: string;
  totalBytes?: string;
  unit?: string;
} = {}): MaterializedDatasetResource {
  return {
    field: {
      coverage: {
        chunk_count: "1",
        component_count: componentCount,
        dtype,
        endian: "little",
        total_bytes: totalBytes,
        total_elements: "2",
      },
      descriptor: {
        active_support: { support_fingerprint: "support" },
        complex_encoding: "real",
        function_space: {
          basis_id: "p1",
          family: "lagrange",
          order: "1",
          ordering: "by_node",
          space_id: "fem-p1",
          vector_dimension: componentCount,
        },
        harmonic_convention: null,
        layout_digest: "layout",
        normalization: "none",
        quantity_id: quantityId,
        sample_location: "node",
        tensor_rank: "1",
        topology_id: "topology",
        unit,
        value_representation: "physical_field",
      },
      field_id: "field",
      group_id: "group",
      item_id: "item",
      plane: "values",
      sample_id: "sample",
      tensor_artifact: {
        artifact_id: "tensor",
        byte_length: totalBytes,
        object_ref: "tensor-object",
        schema_id: "tensor-schema",
      },
      tensor_byte_length: totalBytes,
      tensor_schema_id: "tensor-schema",
      accepted_state: null,
      producer_id: "producer",
      producer_version: "1",
    },
    dataset: {
      dataset_id: "dataset",
      definition_id: "definition",
      definition_revision: "1",
      revision: "1",
      schema_version: "1",
      source: {
        artifact_id: "tensor",
        member_id: "member",
        run_id: "run",
        run_spec_digest: "digest",
        solution_revision: "1",
        solution_set_id: "solution",
        tensor_object_ref: "tensor-object",
      },
      status: { availability: "available", actions: [] },
    },
    artifact_id: "artifact",
    containing_solution_revision: "1",
    definition: {} as never,
    field_id: "field",
    integrity: "verified",
    item_id: "item",
    manifest_byte_length: "1",
    manifest_object_ref: "manifest",
    member_id: "member",
    owner_execution_status: "completed",
    owner_scientific_assessment: {
      evidence_artifact_count: 0,
      status: "unassessed",
    },
    owner_solution_revision: "1",
    project_id: "project",
    run_id: "run",
    sample_id: "sample",
    schema_version: "fullmag.analysis.materialized_dataset.v1",
    solution_set_id: "solution",
    source: {
      artifact_id: "tensor",
      member_id: "member",
      run_id: "run",
      run_spec_digest: "digest",
      solution_revision: "1",
      solution_set_id: "solution",
      tensor_object_ref: "tensor-object",
    },
  } as unknown as MaterializedDatasetResource;
}

function geometryFixture(): SavedFieldGeometryResource {
  return {
    active_node_count: "1",
    cell_count: "1",
    facet_count: "1",
    layout_digest: "layout",
    node_count: "2",
    representation_evidence: "not_verified",
    support_fingerprint: "support",
    topology_fingerprint: "topology",
  } as unknown as SavedFieldGeometryResource;
}

function topologyFixture(): DecodedTopology {
  return {
    cellCount: 1,
    facetCount: 1,
    formatVersion: 2,
    nodeCount: 2,
    positions: new Float64Array([0, 0, 0, 1, 0, 0]),
  } as unknown as DecodedTopology;
}

function supportFixture(): DecodedSavedSupport {
  return { bits: new Uint8Array([0b00000001]), nodeCount: 2 };
}

describe("saved field viewport admission", () => {
  it("admits bounded real nodal m vectors in both producer precisions", () => {
    const common = [geometryFixture(), topologyFixture(), supportFixture()] as const;
    expect(
      resolveSavedFieldViewportEligibility(datasetFixture(), ...common),
    ).toMatchObject({ status: "ready", totalBytes: 48 });
    expect(
      resolveSavedFieldViewportEligibility(
        datasetFixture({ dtype: "f32", totalBytes: "24" }),
        ...common,
      ),
    ).toMatchObject({ status: "ready", totalBytes: 24 });
  });

  it("fails closed for non-m or non-vector saved quantities", () => {
    const common = [geometryFixture(), topologyFixture(), supportFixture()] as const;
    expect(
      resolveSavedFieldViewportEligibility(
        datasetFixture({ quantityId: "H_eff" }),
        ...common,
      ).status,
    ).toBe("unavailable");
    expect(
      resolveSavedFieldViewportEligibility(
        datasetFixture({ componentCount: "1", totalBytes: "16" }),
        ...common,
      ).status,
    ).toBe("unavailable");
  });
});
