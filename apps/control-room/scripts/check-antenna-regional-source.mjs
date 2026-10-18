import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../src/shared/domain/physics/antennaRegionalSource.ts", import.meta.url), "utf8");
const { antennaRegionalSources } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const canonical = { id: "regional", kind: "regional", enabled: false, spatial_profile: { kind: "geometry_mask", object_id: "antenna" } };
const legacy = { kind: "antenna_field_source", model: "prescribed_zeeman_mask", object: "antenna" };
const scene = { field_drives: { drives: [canonical] }, current_modules: { modules: [legacy] } };
const before = structuredClone(scene);
assert.deepEqual(antennaRegionalSources(null, "antenna"), { canonical: null, legacy: null });
assert.deepEqual(antennaRegionalSources(scene, null), { canonical: null, legacy: null });
assert.deepEqual(antennaRegionalSources({ objects: [{ id: "antenna", role: "antenna", name: "regional" }] }, "antenna"), { canonical: null, legacy: null });
assert.deepEqual(antennaRegionalSources(scene, "other"), { canonical: null, legacy: null });
assert.equal(antennaRegionalSources(scene, "antenna").canonical, canonical);
assert.equal(antennaRegionalSources(scene, "antenna").legacy, legacy);
assert.equal(antennaRegionalSources(scene, "antenna").canonical.enabled, false);
for (const profile of [null, { kind: "uniform", object_id: "antenna" }, { kind: "geometry_mask", object_id: "other" }]) {
  assert.equal(antennaRegionalSources({ field_drives: { drives: [{ ...canonical, spatial_profile: profile }] } }, "antenna").canonical, null);
}
assert.equal(antennaRegionalSources({ field_drives: { drives: [null, "invalid", canonical] } }, "antenna").canonical, canonical);
assert.deepEqual(antennaRegionalSources({ field_drives: { drives: {} }, current_modules: { modules: {} } }, "antenna"), { canonical: null, legacy: null });
assert.deepEqual(scene, before);
console.log("PASS explicit geometry-mask bindings, legacy identity, disabled state, unrelated sources, malformed entries, immutable inputs and no role/name activation; interpreted production source only.");
