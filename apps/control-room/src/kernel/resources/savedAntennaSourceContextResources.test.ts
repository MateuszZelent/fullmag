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
    solutionSets: vi.fn(),
    solutionSetMembers: vi.fn(),
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


function retainedFixture() {
  const field = dataset("H_ant");
  field.field.producer_id = "fullmag.retained-current-field";
  field.field.producer_version = "1";
  const source = dataset("V_electric");
  Object.assign(source, { run_id: "run-parent", solution_set_id: "solution-parent", member_id: "member-parent",
    item_id: "parent-package" });
  source.source = { ...source.source, run_id: source.run_id, solution_set_id: source.solution_set_id,
    member_id: source.member_id };
  source.dataset.source = source.source;
  source.definition.source = source.source;
  source.field.item_id = source.item_id;
  const parent = { project_id: field.project_id, run_id: source.run_id, study_step_id: "parent-stage",
    task_id: "parent-task", attempt_id: "parent-attempt", ownership_epoch: "1",
    artifact_id: source.item_id, package_object_ref: "f".repeat(64), package_byte_length: "1234" };
  const fieldGeometry = { ...geometry(field), antenna_source_context: {
    purpose: "historical_geometry_only", source_package: { artifact_id: field.field.item_id,
      object_ref: "c".repeat(64), byte_length: "4567", kind: "other", accepted_state: null,
      schema_id: "fullmag.antenna.retained_current_field_bundle@v1" }, parent } };
  const { client, topology } = clientFixture([source]);
  client.solutionSets.mockResolvedValue({ schema_version: "fullmag.analysis.solution_set_discovery.v1",
    project_id: field.project_id, run_id: parent.run_id, next_cursor: null,
    items: [{ solution_set_id: source.solution_set_id, revision: "2", manifest_digest: "sha256:" + "e".repeat(64) }] });
  client.solutionSetMembers.mockResolvedValue({ schema_version: "fullmag.analysis.solution_revision.v1",
    project_id: field.project_id, run_id: parent.run_id, solution_set_id: source.solution_set_id,
    revision: "2", manifest_digest: "sha256:" + "e".repeat(64), next_after_member_id: null,
    items: [{ member_id: source.member_id, stage_id: parent.study_step_id, task_id: parent.task_id,
      attempt_id: parent.attempt_id, ownership_epoch: parent.ownership_epoch, case_id: "default", execution_status: "succeeded" }] });
  client.solutionSetArtifacts.mockResolvedValue({ ...artifactPage([source]), run_id: parent.run_id,
    solution_set_id: source.solution_set_id, member_id: source.member_id,
    items: [...artifactPage([source]).items, { artifact_id: parent.artifact_id, object_ref: parent.package_object_ref,
      byte_length: parent.package_byte_length, schema_id: "fullmag.antenna.closed_loop_bundle@v1", kind: "other", accepted_state: null }] });
  client.savedFieldGeometry.mockImplementation((value) => Promise.resolve(value === field ? fieldGeometry : geometry(source)));
  return { field, source, fieldGeometry, parent, client, topology };
}

describe("retained H-only historical source context", () => {
  it.each(["v1", "v2"])("retains raw H and exact historical parent pins for %s", async (version) => {
    const { field, source, fieldGeometry, client } = retainedFixture();
    fieldGeometry.antenna_source_context.source_package.schema_id = `fullmag.antenna.retained_current_field_bundle@${version}`;
    const before = structuredClone(field);
    const result = await loadSavedAntennaSourceContext(client, field, new AbortController().signal);
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.dataset).toBe(source);
    expect(field).toEqual(before);
    expect(client.savedFieldGeometry).toHaveBeenCalledWith(field, expect.anything(), { include_antenna_source_context: true });
    expect(client.materializedDatasetSlice).not.toHaveBeenCalled();
    expect(client.scene).not.toHaveBeenCalled();
  });

  it.each(["v3", "v2-extra", "V2"])("rejects unsupported retained package schema %s", async (version) => {
    const { field, fieldGeometry, client } = retainedFixture();
    fieldGeometry.antenna_source_context.source_package.schema_id = `fullmag.antenna.retained_current_field_bundle@${version}`;
    expect((await loadSavedAntennaSourceContext(client, field, new AbortController().signal)).status).toBe("unavailable");
    expect(client.solutionSets).not.toHaveBeenCalled();
    expect(client.savedFieldTopology).not.toHaveBeenCalled();
  });

  it("loads the pinned parent conductor for a failed child without values, live scene or accepted catalog", async () => {
    const { field, source, fieldGeometry, client, topology } = retainedFixture();
    const signal = new AbortController().signal;
    expect(await loadSavedAntennaSourceContext(client, field, signal)).toEqual({ status: "ready",
      fieldDatasetKey: savedGeometryResourceKey(field), dataset: source, geometry: geometry(source), topology });
    expect(client.savedFieldGeometry).toHaveBeenCalledWith(field, { signal }, { include_antenna_source_context: true });
    expect(fieldGeometry.antenna_source_context.purpose).toBe("historical_geometry_only");
    expect(client.materializedDatasetSlice).not.toHaveBeenCalled();
    expect(client.scene).not.toHaveBeenCalled();
  });

  it.each(["project_id", "artifact_id", "package_object_ref", "package_byte_length"] as const)(
    "refuses mismatched parent %s without using the edited scene", async (key) => {
      const { field, parent, client } = retainedFixture();
      parent[key] = key === "package_object_ref" ? "0".repeat(64) : key === "package_byte_length" ? "1235" : "foreign";
      const result = await loadSavedAntennaSourceContext(client, field, new AbortController().signal);
      expect(result.status).toBe("unavailable");
      expect(client.savedFieldTopology).not.toHaveBeenCalled();
      expect(client.scene).not.toHaveBeenCalled();
    },
  );

  it.each(["task_id", "attempt_id", "ownership_epoch", "study_step_id"] as const)(
    "refuses mismatched parent execution %s", async (key) => {
      const { field, parent, client } = retainedFixture(); parent[key] = "foreign";
      expect((await loadSavedAntennaSourceContext(client, field, new AbortController().signal)).status).toBe("unavailable");
      expect(client.savedFieldTopology).not.toHaveBeenCalled();
    },
  );

  it("keeps missing optional context unavailable without discovering an arbitrary conductor", async () => {
    const { field, client } = retainedFixture(); client.savedFieldGeometry.mockResolvedValue(geometry(field));
    expect((await loadSavedAntennaSourceContext(client, field, new AbortController().signal)).status).toBe("unavailable");
    expect(client.solutionSets).not.toHaveBeenCalled();
    expect(client.savedFieldTopology).not.toHaveBeenCalled();
  });

  it("does not consume child-of-child or magnetic V as a conductor", async () => {
    const { field, source, client } = retainedFixture(); source.field.producer_id = "fullmag.retained-current-field";
    expect((await loadSavedAntennaSourceContext(client, field, new AbortController().signal)).status).toBe("unavailable");
    expect(client.savedFieldTopology).not.toHaveBeenCalled();
  });

  it("propagates opt-in network errors and never substitutes live geometry", async () => {
    const { field, client } = retainedFixture(); client.savedFieldGeometry.mockRejectedValue(new Error("offline"));
    await expect(loadSavedAntennaSourceContext(client, field, new AbortController().signal)).rejects.toThrow("offline");
    expect(client.scene).not.toHaveBeenCalled();
  });

  it("keeps an explicit provenance conflict local to source context", async () => {
    const { field, client } = retainedFixture();
    const { ControlRoomApiError } = await import("../api/ControlRoomApi");
    client.savedFieldGeometry.mockRejectedValue(new ControlRoomApiError("wrong parent", 409));
    expect((await loadSavedAntennaSourceContext(client, field, new AbortController().signal)).status).toBe("unavailable");
    expect(client.solutionSets).not.toHaveBeenCalled();
  });

  it("rejects a changed parent manifest and duplicate artifacts", async () => {
    const changed = retainedFixture();
    changed.client.solutionSetMembers.mockResolvedValue({ ...await changed.client.solutionSetMembers(),
      manifest_digest: "sha256:" + "0".repeat(64) });
    await expect(loadSavedAntennaSourceContext(changed.client, changed.field, new AbortController().signal))
      .rejects.toThrow("changed their pinned manifest");
    const duplicate = retainedFixture();
    const page = await duplicate.client.solutionSetArtifacts();
    duplicate.client.solutionSetArtifacts.mockResolvedValue({ ...page, items: [...page.items, page.items[0]] });
    await expect(loadSavedAntennaSourceContext(duplicate.client, duplicate.field, new AbortController().signal))
      .rejects.toThrow("repeated an artifact");
  });

  it("rejects a second matching V dataset rather than choosing the first", async () => {
    const { field, source, client } = retainedFixture();
    const duplicate = structuredClone(source); duplicate.artifact_id = "materialized-dataset-" + "0".repeat(64);
    duplicate.manifest_object_ref = "0".repeat(64);
    const page = await client.solutionSetArtifacts();
    client.solutionSetArtifacts.mockResolvedValue({ ...page, items: [...page.items, {
      ...page.items[0], artifact_id: duplicate.artifact_id, object_ref: duplicate.manifest_object_ref }] });
    client.materializedDataset.mockImplementation((_p, _r, _s, _v, _m, id) => Promise.resolve(
      id === duplicate.artifact_id ? duplicate : source));
    expect((await loadSavedAntennaSourceContext(client, field, new AbortController().signal)).status).toBe("unavailable");
    expect(client.savedFieldTopology).not.toHaveBeenCalled();
  });

  it("bounds metadata requests even when every discovery page is valid", async () => {
    const { field, client } = retainedFixture();
    const page = await client.solutionSets();
    client.solutionSets.mockImplementation((_p, _r, query) => Promise.resolve({ ...page,
      next_cursor: query.cursor ? null : "next",
      items: Array.from({ length: 50 }, (_, i) => ({ solution_set_id: "solution-" + (query.cursor ?? "first") + i,
        revision: "2", manifest_digest: "sha256:" + "e".repeat(64) })) }));
    client.solutionSetMembers.mockImplementation((_p, _r, id) => Promise.resolve({
      schema_version: "fullmag.analysis.solution_revision.v1", project_id: field.project_id, run_id: "run-parent",
      solution_set_id: id, revision: "2", manifest_digest: "sha256:" + "e".repeat(64), items: [], next_after_member_id: null }));
    await expect(loadSavedAntennaSourceContext(client, field, new AbortController().signal))
      .rejects.toThrow("bounded metadata budget");
    expect(client.solutionSetMembers.mock.calls.length).toBeGreaterThan(50);
    expect(client.solutionSetMembers.mock.calls.length + client.solutionSets.mock.calls.length - 1).toBeLessThanOrEqual(64);
    expect(client.savedFieldTopology).not.toHaveBeenCalled();
  });

  it("honors cancellation before discovering parent metadata", async () => {
    const { field, client } = retainedFixture(); const abort = new AbortController(); abort.abort();
    await expect(loadSavedAntennaSourceContext(client, field, abort.signal)).rejects.toThrow();
    expect(client.solutionSets).not.toHaveBeenCalled();
  });
});
