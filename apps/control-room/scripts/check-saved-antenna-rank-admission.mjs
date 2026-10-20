import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../src/kernel/api/savedGeometryIdentity.ts", import.meta.url), "utf8");
const javascript = stripTypeScriptTypes(source);
const { isSavedOwnedSampleGeometry } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
let checks = 0;
for (const [quantity, unit, components, role, rank] of [
  ["V_electric", "V", "1", "source_nodes", "0"],
  ["J_charge", "A/m^2", "3", "tet4_cell_local_nodes", "1"],
  ["H_ant", "A/m", "3", "sample_nodes", "1"],
]) {
  const descriptor = { quantity_id: quantity, unit, tensor_rank: rank, normalization: "none", complex_encoding: "real",
    value_representation: "physical_field", sample_location: "node", harmonic_convention: null, modal_semantics: null,
    layout_digest: "layout", carrier_id: `carrier:${role}:layout`,
    function_space: { family: "owned_sample_values", order: "0", vector_dimension: components, ordering: "by_node", basis_id: `basis:${role}:layout` } };
  const geometry = { geometry_schema_version: "fullmag.owned_sample_field_geometry.v1", producer_id: "fullmag.closed-loop-inspection", producer_version: "2",
    tensor_artifact: { accepted_state: null }, geometry_manifest: { accepted_state: null }, dataset: { descriptor } };
  const before = structuredClone(geometry);
  assert.equal(isSavedOwnedSampleGeometry(geometry), true, `${quantity}: canonical raw field rejected`); checks += 1;
  assert.deepEqual(geometry, before, "Admission must not rewrite persisted metadata"); checks += 1;
  for (const invalid of [undefined, null, 0, 1, "2", "01", "", rank === "0" ? "1" : "0"]) {
    const malformed = structuredClone(geometry); malformed.dataset.descriptor.tensor_rank = invalid;
    assert.equal(isSavedOwnedSampleGeometry(malformed), false, `${quantity}: invalid tensor rank ${String(invalid)} admitted`); checks += 1;
  }
}
console.log(JSON.stringify({ status: "passed", checks, scope: "production saved antenna tensor-rank admission only; no browser or actual artifact qualification" }));
