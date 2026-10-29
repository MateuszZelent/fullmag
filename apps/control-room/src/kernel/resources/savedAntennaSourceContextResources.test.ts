import { describe, expect, it, vi } from "vitest";

import type {
  MaterializedDatasetResource,
  SavedFieldGeometryResource,
  SolutionSetArtifactPageResource,
} from "../api/apiTypes";
import type { DecodedTopology } from "../api/codecs/types";
import { savedGeometryResourceKey } from "./savedGeometryResources";
import type { ResourceResult } from "./resourceTypes";
import {
  loadSavedAntennaSourceContext,
  resolveSavedAntennaSourceContextResource,
  resolveSavedAntennaSourceDataset,
  type SavedAntennaSourceContext,
} from "./savedAntennaSourceContextResources";

function dataset(quantity: "H_ant" | "V_electric", hash = quantity === "H_ant" ? "a" : "b"): MaterializedDatasetResource {
  const objectRef = hash.repeat(64);
  const source = {
    run_id: "run-a", solution_set_id: "solution-a", solution_revision: "1",
    member_id: "member-a", artifact_id: "tensor-" + objectRef, tensor_object_ref: objectRef,
    run_spec_digest: "sha256:" + "d".repeat(64),
  };
  const descriptor = {
    quantity_id: quantity, unit: quantity === "H_ant" ? "A/m" : "V",
    tensor_rank: quantity === "H_ant" ? "1" : "0",
    sample_location: "node", normalization: "none", complex_encoding: "real",
    value_representation: "physical_field", layout_digest: "layout-" + quantity,
    function_space: {
      family: "owned_sample_values", order: "0", ordering: "by_node",
      vector_dimension: quantity === "H_ant" ? "3" : "1",
      basis_id: "basis:" + (quantity === "H_ant" ? "sample_nodes:" : "source_nodes:") + "layout-" + quantity,
    },
    carrier_id: "carrier:" + (quantity === "H_ant" ? "sample_nodes:" : "source_nodes:") + "layout-" + quantity,
  };
  return {
    schema_version: "fullmag.analysis.materialized_dataset.v1", integrity: "verified",
    project_id: "project-a", run_id: source.run_id, solution_set_id: source.solution_set_id,
    containing_solution_revision: "2", owner_solution_revision: "1", member_id: source.member_id,
    artifact_id: "materialized-dataset-" + objectRef, manifest_object_ref: objectRef,
    manifest_byte_length: "200", source, sample_id: "default", item_id: "inspection-a", field_id: quantity,
    dataset: {
      schema_version: "1.0.0", dataset_id: "dataset-" + quantity, revision: "1",
      definition_id: "definition-" + quantity, definition_revision: "1", source,
      status: { availability: "ready", actions: [] },
    },
    definition: {
      schema_version: "1.0.0", definition_id: "definition-" + quantity, revision: "1", source,
    },
    field: {
      producer_id: "fullmag.closed-loop-inspection", producer_version: "2",
      item_id: "inspection-a", sample_id: "default", field_id: quantity, plane: "values",
      descriptor, accepted_state: null, tensor_schema_id: "fullmag.tensor.v1", tensor_byte_length: "100",
      tensor_artifact: {
        artifact_id: source.artifact_id, object_ref: source.tensor_object_ref,
        schema_id: "fullmag.tensor.v1", byte_length: "100",
      },
      coverage: { component_count: quantity === "H_ant" ? "3" : "1" },
    },
  } as unknown as MaterializedDatasetResource;
}

function geometry(source: MaterializedDatasetResource): SavedFieldGeometryResource {
  return {
    geometry_schema_version: "fullmag.owned_sample_field_geometry.v1",
    producer_id: source.field.producer_id, producer_version: source.field.producer_version,
    dataset: { descriptor: source.field.descriptor },
    tensor_artifact: { accepted_state: null }, geometry_manifest: { accepted_state: null, object_ref: "geometry" },
  } as unknown as SavedFieldGeometryResource;
}

function artifactPage(datasets: MaterializedDatasetResource[]): SolutionSetArtifactPageResource {
  return {
    schema_version: "fullmag.analysis.solution_revision.v1",
    project_id: "project-a", run_id: "run-a", solution_set_id: "solution-a", revision: "2",
    member_id: "member-a", manifest_digest: "sha256:" + "e".repeat(64),
    next_after_artifact_id: null,
    items: datasets.map((value) => ({
      artifact_id: value.artifact_id, object_ref: value.manifest_object_ref,
      schema_id: "fullmag.materialized_dataset.v1", byte_length: value.manifest_byte_length,
      kind: "other", integrity: "not_verified", scientific_evidence: false,
    })),
  };
}

function clientFixture(fields = [dataset("H_ant"), dataset("V_electric")]) {
  const source = fields.find((value) => value.field.descriptor.quantity_id === "V_electric")!;
  const topology = { nodeCount: 4 } as DecodedTopology;
  const client = {
    solutionSetArtifacts: vi.fn().mockResolvedValue(artifactPage(fields)),
    materializedDataset: vi.fn().mockImplementation(
      (_project, _run, _solution, _revision, _member, artifactId) =>
        Promise.resolve(fields.find((value) => value.artifact_id === artifactId)),
    ),
    savedFieldGeometry: vi.fn().mockResolvedValue(source ? geometry(source) : null),
    savedFieldTopology: vi.fn().mockResolvedValue(topology),
    materializedDatasetSlice: vi.fn(),
    scene: vi.fn(),
  };
  return { client, source, topology };
}

describe("saved antenna source context", () => {
  it("associates only the exact immutable V sibling, despite different H/source topology", () => {
    const h = dataset("H_ant");
    const v = dataset("V_electric");
    expect(resolveSavedAntennaSourceDataset(h, [h, v])).toEqual({ status: "ready", dataset: v });
  });

  it.each([
    "project_id", "run_id", "solution_set_id", "containing_solution_revision",
    "owner_solution_revision", "member_id", "item_id",
  ] as const)("refuses mismatched %s instead of guessing by a name", (key) => {
    const v = dataset("V_electric");
    v[key] = "different";
    expect(resolveSavedAntennaSourceDataset(dataset("H_ant"), [v]).status).toBe("unavailable");
  });

  it.each([
    "run_id", "solution_set_id", "solution_revision", "member_id", "run_spec_digest",
  ] as const)("refuses mismatched pinned source %s", (key) => {
    const v = dataset("V_electric");
    v.source = { ...v.source, [key]: "different" };
    expect(resolveSavedAntennaSourceDataset(dataset("H_ant"), [v]).status).toBe("unavailable");
  });

  it("rejects missing, duplicate and incompatible producer source datasets", () => {
    const h = dataset("H_ant");
    const v = dataset("V_electric");
    expect(resolveSavedAntennaSourceDataset(h, []).status).toBe("unavailable");
    expect(resolveSavedAntennaSourceDataset(h, [v, dataset("V_electric", "c")]).status).toBe("unavailable");
    v.field.producer_version = "3";
    expect(resolveSavedAntennaSourceDataset(h, [v]).status).toBe("unavailable");
    v.field.producer_version = "2";
    v.field.producer_id = "ferromagnet";
    expect(resolveSavedAntennaSourceDataset(h, [v]).status).toBe("unavailable");
  });

  it("loads only pinned metadata and source geometry without values or live fallback", async () => {
    const h = dataset("H_ant");
    const { client, source, topology } = clientFixture();
    const signal = new AbortController().signal;
    const result = await loadSavedAntennaSourceContext(client, h, signal);
    expect(result).toEqual({
      status: "ready", dataset: source, geometry: geometry(source), topology,
      fieldDatasetKey: savedGeometryResourceKey(h),
    });
    expect(client.savedFieldGeometry).toHaveBeenCalledWith(source, { signal });
    expect(client.savedFieldTopology).toHaveBeenCalledWith(source, geometry(source), { signal });
    expect(client.materializedDatasetSlice).not.toHaveBeenCalled();
    expect(client.scene).not.toHaveBeenCalled();
  });

  it("checks all pinned pages before deciding a source is unique", async () => {
    const h = dataset("H_ant");
    const v = dataset("V_electric");
    const duplicate = dataset("V_electric", "c");
    const { client } = clientFixture([h, v, duplicate]);
    client.solutionSetArtifacts
      .mockReset()
      .mockResolvedValueOnce({ ...artifactPage([h, v]), next_after_artifact_id: v.artifact_id })
      .mockResolvedValueOnce(artifactPage([duplicate]));
    expect((await loadSavedAntennaSourceContext(client, h, new AbortController().signal)).status)
      .toBe("unavailable");
    expect(client.solutionSetArtifacts).toHaveBeenCalledTimes(2);
    expect(client.savedFieldGeometry).not.toHaveBeenCalled();
  });

  it("keeps missing and untransportable source contexts unavailable", async () => {
    const missing = clientFixture([dataset("H_ant")]);
    expect((await loadSavedAntennaSourceContext(missing.client, dataset("H_ant"), new AbortController().signal)).status)
      .toBe("unavailable");
    expect(missing.client.savedFieldGeometry).not.toHaveBeenCalled();
    const bounded = clientFixture();
    bounded.client.savedFieldTopology.mockResolvedValue(null);
    expect((await loadSavedAntennaSourceContext(bounded.client, dataset("H_ant"), new AbortController().signal)).status)
      .toBe("unavailable");
    expect(bounded.client.scene).not.toHaveBeenCalled();
  });

  it("refuses a changed pinned manifest and propagates errors without a live substitute", async () => {
    const h = dataset("H_ant");
    const v = dataset("V_electric");
    const { client } = clientFixture();
    client.solutionSetArtifacts
      .mockReset()
      .mockResolvedValueOnce({ ...artifactPage([h]), next_after_artifact_id: h.artifact_id })
      .mockResolvedValueOnce({ ...artifactPage([v]), manifest_digest: "sha256:" + "f".repeat(64) });
    await expect(loadSavedAntennaSourceContext(client, h, new AbortController().signal))
      .rejects.toThrow("changed its pinned manifest");
    expect(client.savedFieldGeometry).not.toHaveBeenCalled();
    expect(client.scene).not.toHaveBeenCalled();
  });

  it("never exposes old conductor geometry under a newly selected field identity", () => {
    const h = dataset("H_ant");
    const ready: SavedAntennaSourceContext = {
      status: "ready", fieldDatasetKey: savedGeometryResourceKey(h),
      dataset: dataset("V_electric"), geometry: geometry(dataset("V_electric")),
      topology: { nodeCount: 4 } as DecodedTopology,
    };
    const resource: ResourceResult<SavedAntennaSourceContext> = {
      status: "ready", data: ready, error: null, revision: "geometry", refetch: vi.fn(),
    };
    expect(resolveSavedAntennaSourceContextResource(h, resource)).toBe(ready);
    const changed = dataset("H_ant", "c");
    expect(resolveSavedAntennaSourceContextResource(changed, resource).status).toBe("loading");
    expect(resolveSavedAntennaSourceContextResource(null, resource).status).toBe("unavailable");
    expect(resolveSavedAntennaSourceContextResource(h, { ...resource, refreshError: new Error("offline") }))
      .toEqual({ status: "error", reason: "offline" });
  });
});
