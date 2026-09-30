import { describe, expect, it } from "vitest";

import {
  assertMaterializedDatasetPathId,
  assertSolutionSetLogicalId,
  assertSolutionSetMemberId,
  assertSolutionSetProjectId,
  assertSolutionSetRevision,
  assertSolutionSetRunId,
} from "../api/ControlRoomApi";
import type {
  MaterializedDatasetResource,
  SolutionSetArtifactPageResource,
  SolutionSetResource,
} from "../api/apiTypes";

import {
  SOLUTION_SET_SCHEMA_VERSION,
  materializedDatasetResourceKey,
  validateMaterializedDatasetEnvelope,
  solutionSetArtifactsResourceKey,
  solutionSetMembersResourceKey,
  solutionSetResourceKey,
  validateSolutionSetEnvelope,
} from "./solutionSetResources";

describe("durable SolutionSet resource identity", () => {
  it("bounds dataset lookup IDs in UTF-8 bytes", () => {
    expect(assertMaterializedDatasetPathId("member id", "ą".repeat(512))).toHaveLength(512);
    expect(() => assertMaterializedDatasetPathId("artifact id", "ą".repeat(513))).toThrow();
  });
  it("fences dataset metadata while preserving a Running/Unassessed historical owner", () => {
    const data = datasetFixture();
    const expected = {
      projectId: data.project_id,
      runId: data.run_id,
      solutionSetId: data.solution_set_id,
      revision: data.containing_solution_revision,
      memberId: data.member_id,
      artifactId: data.artifact_id,
    };
    expect(validateMaterializedDatasetEnvelope(data, expected)).toBe(data);
    expect(data.owner_execution_status).toBe("running");
    expect(data.owner_scientific_assessment.status).toBe("unassessed");
    for (const field of ["project_id", "run_id", "solution_set_id", "member_id", "artifact_id"] as const) {
      expect(() => validateMaterializedDatasetEnvelope({ ...data, [field]: "other" }, expected)).toThrow();
    }
    expect(() => validateMaterializedDatasetEnvelope({ ...data, owner_solution_revision: "9007199254740994" }, expected)).toThrow();
    expect(() => validateMaterializedDatasetEnvelope({ ...data, manifest_byte_length: "4194305" }, expected)).toThrow();
    expect(() => validateMaterializedDatasetEnvelope({ ...data, source: { ...data.source, solution_revision: "1" } }, expected)).toThrow();
    expect(() => validateMaterializedDatasetEnvelope({ ...data, dataset: { ...data.dataset, source: { ...data.source, run_id: "other" } } }, expected)).toThrow();
    expect(() => validateMaterializedDatasetEnvelope({ ...data, field: { ...data.field, tensor_artifact: { ...data.field.tensor_artifact, object_ref: "d".repeat(64) } } }, expected)).toThrow();
    expect(() => validateMaterializedDatasetEnvelope({ ...data, manifest_object_ref: "bad" }, expected)).toThrow();
    expect(() => validateMaterializedDatasetEnvelope(JSON.parse(JSON.stringify({ ...data, integrity: "not_verified" })), expected)).toThrow();
    expect(() => validateMaterializedDatasetEnvelope({ ...data, definition: { ...data.definition, revision: "01" } }, expected)).toThrow();
  });
  it("separates every pinned dataset owner and preserves u64 revisions", () => {
    const identity = {
      projectId: "project-a",
      runId: "run-a",
      solutionSetId: "solution/żółć",
      revision: "9007199254740993",
      memberId: "member:a/b",
      artifactId: "artifact:a/b",
    };
    const key = materializedDatasetResourceKey(identity);
    expect(key).toContain("9007199254740993");
    expect(key).toContain("solution%2F%C5%BC%C3%B3%C5%82%C4%87");
    expect(key).toContain("member%3Aa%2Fb");
    expect(key).toContain("artifact%3Aa%2Fb");
    for (const [field, value] of Object.entries({
      projectId: "project-b",
      runId: "run-b",
      solutionSetId: "other-solution",
      revision: "9007199254740992",
      memberId: "other-member",
      artifactId: "other-artifact",
    })) {
      expect(materializedDatasetResourceKey({ ...identity, [field]: value })).not.toBe(key);
    }
  });
  it("keeps the exact decimal revision in every project-scoped cache key", () => {
    const revision = "9007199254740993";

    const rootKey = solutionSetResourceKey("project-a", "run-a", "set/a", revision);
    expect(rootKey).toBe(
      "solution-set:project-a:run-a:set%2Fa:9007199254740993",
    );
    expect(solutionSetResourceKey("project-b", "run-a", "set/a", revision)).not.toBe(
      rootKey,
    );
    expect(solutionSetResourceKey("project-a", "run-b", "set/a", revision)).not.toBe(
      rootKey,
    );
    expect(solutionSetResourceKey("project-a", "run-a", "set/b", revision)).not.toBe(
      rootKey,
    );
    expect(solutionSetResourceKey("project-a", "run-a", "set/a", "1")).not.toBe(
      rootKey,
    );
    expect(
      solutionSetResourceKey("projekt-a", "run-a", "solution/żółć", revision),
    ).toContain("solution%2F%C5%BC%C3%B3%C5%82%C4%87");
    const memberKey =
      solutionSetMembersResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        { after_member_id: "member/a", limit: 100 },
      );
    expect(memberKey).toContain(":members:limit=100&after=member%2Fa");
    expect(
      solutionSetMembersResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        { after_member_id: "member/a", limit: 50 },
      ),
    ).not.toBe(memberKey);
    const artifactKey =
      solutionSetArtifactsResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        "member/a",
        { after_artifact_id: "artifact/a", limit: 50 },
      );
    expect(artifactKey).toContain(":member:member%2Fa:artifacts:limit=50&after=artifact%2Fa");
    expect(
      solutionSetArtifactsResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        "member/b",
        { after_artifact_id: "artifact/a", limit: 50 },
      ),
    ).not.toBe(artifactKey);
  });

  it("rejects revision precision loss and unsafe path identifiers locally", () => {
    expect(assertSolutionSetRevision("1")).toBe("1");
    expect(assertSolutionSetRevision("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => assertSolutionSetRevision("0")).toThrow();
    expect(() => assertSolutionSetRevision("01")).toThrow();
    expect(() => assertSolutionSetRevision("18446744073709551616")).toThrow();
    expect(assertSolutionSetLogicalId("solution/żółć")).toBe("solution/żółć");
    expect(assertSolutionSetMemberId("member id", "member/żółć")).toBe(
      "member/żółć",
    );
    expect(() => assertSolutionSetLogicalId(`solution${"ż".repeat(600)}`)).toThrow();
    expect(() => assertSolutionSetMemberId("member id", "member\u0001")).toThrow();
    expect(() => assertSolutionSetProjectId("project/a")).toThrow();
    expect(() => assertSolutionSetRunId("run/a")).toThrow();
  });

  it("fails closed on schema, digest, and pinned owner mismatches", () => {
    const identity = {
      projectId: "project",
      revision: "9007199254740993",
      runId: "run",
      solutionSetId: "set",
    };
    const base = {
      artifact_count: 0,
      coverage_count: 0,
      execution_status: "succeeded",
      manifest_digest: `sha256:${"a".repeat(64)}`,
      manifest_state: "closed",
      member_count: 0,
      project_id: identity.projectId,
      provenance: {
        acquisition_digest: "sha256:acquisition",
        discretization_digest: "sha256:discretization",
        model_digest: "sha256:model",
        physics_digest: "sha256:physics",
        resolved_plan_digest: "sha256:plan",
        run_spec_digest: "sha256:run-spec",
        seed_digest: null,
      },
      revision: identity.revision,
      run_id: identity.runId,
      schema_version: SOLUTION_SET_SCHEMA_VERSION,
      scientific_assessment: {
        evidence_artifact_count: 0,
        reason: null,
        status: "unassessed",
      },
      solution_set_id: identity.solutionSetId,
    } as SolutionSetResource;

    expect(validateSolutionSetEnvelope(base, identity)).toBe(base);
    expect(() =>
      validateSolutionSetEnvelope(
        { ...base, schema_version: "wrong.schema" },
        identity,
      ),
    ).toThrow();
    expect(() =>
      validateSolutionSetEnvelope(
        { ...base, manifest_digest: "sha256:short" },
        identity,
      ),
    ).toThrow();

    const page = {
      ...base,
      items: [],
      member_id: "member",
      next_after_artifact_id: null,
    } as SolutionSetArtifactPageResource;
    expect(
      validateSolutionSetEnvelope(page, { ...identity, memberId: "member" }),
    ).toBe(page);
    expect(() =>
      validateSolutionSetEnvelope(page, { ...identity, memberId: "other" }),
    ).toThrow();
  });
});

function datasetFixture(): MaterializedDatasetResource {
  const source = {
    run_id: "run",
    solution_set_id: "set",
    solution_revision: "9007199254740992",
    member_id: "member",
    artifact_id: "tensor:m",
    tensor_object_ref: "b".repeat(64),
    run_spec_digest: `sha256:${"c".repeat(64)}`,
  };
  return {
    schema_version: "fullmag.analysis.materialized_dataset.v1",
    project_id: "project",
    run_id: source.run_id,
    solution_set_id: source.solution_set_id,
    containing_solution_revision: "9007199254740993",
    owner_solution_revision: source.solution_revision,
    member_id: source.member_id,
    artifact_id: `materialized-dataset-${"a".repeat(64)}`,
    manifest_object_ref: "a".repeat(64),
    manifest_byte_length: "4096",
    integrity: "verified",
    source,
    owner_execution_status: "running",
    owner_scientific_assessment: { status: "unassessed", reason: null, evidence_artifact_count: 0 },
    sample_id: "sample",
    item_id: "item",
    field_id: "field:m",
    dataset: {
      schema_version: "1.0.0",
      dataset_id: "dataset:m",
      revision: "1",
      definition_id: "definition:m",
      definition_revision: "1",
      source,
      status: { availability: "ready", reason: null, actions: [] },
    },
    definition: {
      schema_version: "1.0.0",
      definition_id: "definition:m",
      revision: "1",
      source,
      domain_selection: { selection_id: `sha256:${"d".repeat(64)}`, selection_revision: "1" },
      axes: [],
      transforms: [],
      evaluation_policy: { precision: "f64", approximation: "exact_only", unavailable_data: "fail" },
    },
    field: {
      sample_id: "sample",
      item_id: "item",
      field_id: "field:m",
      group_id: "group:m",
      producer_id: "producer:fem-p1",
      producer_version: "1",
      tensor_schema_id: "fullmag.tensor.v1",
      tensor_byte_length: "2048",
      plane: "values",
      accepted_state: null,
      tensor_artifact: { artifact_id: source.artifact_id, schema_id: "fullmag.tensor.v1", object_ref: source.tensor_object_ref, byte_length: "2048", accepted_state: null },
      coverage: { total_elements: "6", component_count: "3", dtype: "f64", endian: "little", total_bytes: "48", chunk_count: "1" },
      descriptor: {
        quantity_id: "m",
        unit: "1",
        tensor_rank: "1",
        frame: { kind: "laboratory", frame_id: "frame:global" },
        sample_location: "node",
        active_support: { support_fingerprint: `sha256:${"d".repeat(64)}`, selection: null },
        function_space: { space_id: "space:h1", family: "H1", order: "1", vector_dimension: "3", ordering: "by_node", basis_id: "basis:h1", constraints_fingerprint: null, partition_fingerprint: null, orientation_mapping_ref: null },
        topology_id: `sha256:${"e".repeat(64)}`,
        carrier_id: "carrier:mesh",
        layout_digest: `sha256:${"f".repeat(64)}`,
        axes: [{ axis_id: "node", unit: "1", length: "2" }, { axis_id: "component", unit: "1", length: "3" }],
        component_axis: "component",
        complex_encoding: "real",
        harmonic_convention: null,
        normalization: "unit_vector",
        value_representation: "physical_field",
        modal_semantics: null,
        resolution: "quantitative",
      },
    },
  };
}
