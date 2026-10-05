import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const document = JSON.parse(await readFile(new URL("../src/kernel/api/generated/openapi-v2.json", import.meta.url), "utf8"));
const schemas = document.components.schemas;
const route = document.paths["/v2/platform/compute/profiles"];
assert.ok(route.get && route.post);
assert.ok(route.post.responses["200"] && route.post.responses["201"] && route.post.responses["409"]);
assert.equal(schemas.PositiveThreadCountSchema.type, "integer");
assert.equal(schemas.PositiveThreadCountSchema.minimum, 1);
assert.equal(schemas.PositiveThreadCountSchema.maximum, 4294967295);
assert.equal(schemas.RequestedThreadsSchema.oneOf.length, 2);
assert.deepEqual(schemas.ThreadAutoSchema.enum, ["auto"]);

const nullable = (schema) => schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))
  || (schema.oneOf ?? schema.anyOf ?? []).some(nullable);
for (const [name, fields] of [
  ["ExecutionRequestPatchSchema", ["backend", "device", "precision", "mode", "resources"]],
  ["CpuResourcePatchSchema", ["threads", "affinity", "native_threads", "blas_threads"]],
  ["ComputeResourcePatchSchema", ["target", "cpu", "ram", "scratch", "parallelism", "placement"]],
]) {
  const schema = schemas[name];
  assert.equal(schema.additionalProperties, false);
  for (const field of fields) {
    assert.equal((schema.required ?? []).includes(field), false, `${name}.${field} must allow omission`);
    assert.equal(nullable(schema.properties[field]), false, `${name}.${field} must reject null`);
    assert.equal(Object.hasOwn(schema.properties[field], "default"), false, `${name}.${field} must not invent a null default`);
  }
}
for (const [name, field] of [
  ["CpuResourcePatchSchema", "core_policy"], ["CpuResourcePatchSchema", "numa_node"],
  ["ComputeResourcePatchSchema", "gpu"], ["MemoryResourcePatchSchema", "reservation_bytes"],
  ["GpuResourcesSchema", "vram_per_device_bytes"],
]) {
  assert.equal(nullable(schemas[name].properties[field]), true, `${name}.${field} must preserve an explicit null reset`);
  assert.equal((schemas[name].required ?? []).includes(field), false, `${name}.${field} must also allow omission`);
}
assert.equal((schemas.GpuResourcesSchema.required ?? []).includes("devices_per_task"), false);
assert.equal((schemas.ExecutionProfileInputSchema.required ?? []).includes("defaults"), false);
assert.ok(schemas.ExecutionProfileSchema.required.includes("defaults"));
assert.equal(schemas.PublishExecutionProfileRequest.properties.client_intent_id.maxLength, 200);
console.log(JSON.stringify({ state: "passed", artifact: "generated OpenAPI", sparse_omission_and_null_reset: "verified", unit_test_compilation: false }));
