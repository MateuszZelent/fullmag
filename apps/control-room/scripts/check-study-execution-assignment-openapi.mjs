import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const api = JSON.parse(await readFile(new URL("../src/kernel/api/generated/openapi-v2.json", import.meta.url), "utf8"));
const branches = api.components.schemas.AuthoringTransactionRequest.oneOf;
const assignment = branches.find((branch) => branch.properties?.kind?.enum?.includes("assign_study_execution"));
assert.ok(assignment, "Profile assignment is an explicit atomic authoring transaction.");
for (const field of ["kind", "base_revision", "execution_profile", "execution_layers"]) {
  assert.ok(assignment.required.includes(field), `Atomic assignment requires ${field}.`);
}
assert.equal(assignment.properties.execution_profile.$ref, "#/components/schemas/ExecutionProfileSchema");
assert.equal(assignment.properties.execution_layers.items.$ref, "#/components/schemas/ExecutionLayerSchema");
assert.ok(api.paths["/v2/sessions/current/model/transactions"].post.responses["409"]);
console.log(JSON.stringify({ state: "passed", atomic_profile_assignment: true, required_revision: true, unit_test_compilation: false }));
