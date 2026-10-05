// Inspect generated transport only; no test bundles or solver are compiled.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const api = JSON.parse(await readFile(new URL("../src/kernel/api/generated/openapi-v2.json", import.meta.url), "utf8"));
const schemas = api.components.schemas;
const operation = api.paths["/v2/platform/compute/preview"].post;
assert.ok(operation.responses["200"]);
assert.ok(operation.responses["409"]);
assert.ok(operation.responses["503"]);
assert.deepEqual(schemas.ComputeAdmissionState.enum, ["not_evaluated"]);
assert.equal(schemas.ComputePreviewRequest.properties.study_plan.type, "object");
assert.deepEqual(schemas.ComputePreviewRequest.properties.study_plan.additionalProperties, {});
assert.equal(schemas.ComputePreviewRequest.properties.inputs.maxItems, 256);
assert.equal(schemas.ComputePreviewInput.properties.problem.type, "object");
assert.deepEqual(schemas.ComputePreviewInput.properties.problem.additionalProperties, {});
assert.equal(schemas.ComputePreviewInput.required.includes("layers"), false);
assert.equal(schemas.ExecutionLayerSchema.required.includes("request"), false);
assert.equal(schemas.MaterializedExecutionLayerSchema.required.includes("request"), true);
for (const name of ["threads", "affinity", "native_threads", "blas_threads"]) {
  assert.ok(schemas.CpuResourcesPreviewSchema.required.includes(name));
}
assert.equal(schemas.CpuResourcesPreviewSchema.required.includes("numa_node"), false);
assert.equal(schemas.CpuResourcesPreviewSchema.required.includes("core_policy"), false);
for (const name of ["selector", "device_uuids", "devices_per_task"]) {
  assert.ok(schemas.GpuResourcesPreviewSchema.required.includes(name));
}
assert.equal(schemas.GpuResourcesPreviewSchema.required.includes("vram_per_device_bytes"), false);
assert.equal(schemas.MemoryReservationPreviewSchema.required?.includes("reservation_bytes") ?? false, false);
assert.ok(schemas.ComputeResourcesPreviewSchema.required.includes("ram"));
assert.ok(schemas.ComputeResourcesPreviewSchema.required.includes("scratch"));
assert.equal(schemas.ComputeResourcesPreviewSchema.required.includes("gpu"), false);
assert.equal(schemas.RequestedExecutionPreviewSchema.properties.resources.$ref, "#/components/schemas/ComputeResourcesPreviewSchema");
assert.equal(schemas.ExecutionMaterializationSchema.properties.requested.$ref, "#/components/schemas/RequestedExecutionPreviewSchema");
assert.ok(schemas.ComputePreviewResource.required.includes("study_catalog_sha256"));
assert.ok(schemas.ComputePreviewResource.required.includes("source_digest"));
assert.ok(schemas.ComputePreviewResource.required.includes("blocking_reasons"));
console.log(JSON.stringify({ state: "passed", preview: "typed_materialization_only", admission: "not_evaluated_only", unit_test_compilation: false }));
