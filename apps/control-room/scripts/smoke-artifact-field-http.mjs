import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const dependencies = option("--dependency-workspace");
assert.ok(dependencies, "--dependency-workspace must identify existing qualified dependencies");
const requireDependency = createRequire(pathToFileURL(resolve(dependencies, "apps/control-room/package.json")));
const root = new URL("../src/", import.meta.url), modules = new Map(), packages = new Map();
function load(url) {
  if (!modules.has(url.href)) modules.set(url.href, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8"), { mode: "transform" }), {
    identifier: url.href, initializeImportMeta(meta) { meta.url = url.href; },
  }));
  return modules.get(url.href);
}
async function link(name, parent) {
  if (name.startsWith("@/") || name.startsWith(".")) return load(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, root) : new URL(`${name}.ts`, parent.identifier));
  assert.equal(name, "openapi-fetch", "unexpected external production dependency");
  if (!packages.has(name)) {
    const values = await import(pathToFileURL(requireDependency.resolve(name)).href);
    packages.set(name, new vm.SyntheticModule(Object.keys(values), function () { for (const key of Object.keys(values)) this.setExport(key, values[key]); }));
  }
  return packages.get(name);
}
// One root keeps shared module identities and linking cycles intact.
const entry = new vm.SourceTextModule(`export { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
export { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
export { artifactCarrierQueries, admitArtifactFieldCarrier } from "@/modules/viewport-3d/model/artifactFieldCarrierModel";`);
await entry.link(link); await entry.evaluate();
if (args.includes("--load-only")) {
  console.log(JSON.stringify({ status: "passed", scope: "production client/codec module loading only", sourceModules: modules.size, actualHTTP: false }));
  process.exit(0);
}
const origin = option("--origin"), stage = option("--stage-id");
const parsed = new URL(origin);
assert.ok(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash, "credential-free loopback origin required");
assert.ok(stage && stage.length <= 4096 && !stage.includes("\0"), "runtime stage required");
const inspectionUrl = `${parsed.origin}/v2/sessions/current/data/antenna/stages/${encodeURIComponent(stage)}/external-lead-inspection`;
async function inspection() {
  const response = await fetch(inspectionUrl, { signal: AbortSignal.timeout(30000), redirect: "error" });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; assert.ok(length <= 1048576, "inspection metadata exceeds bound"); chunks.push(value); } }
  finally { await reader.cancel(); }
  return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")), instance: response.headers.get("x-fullmag-api-instance") };
}
const initial = await inspection(), owner = initial.body;
assert.equal(owner.runtime_stage_id, stage); assert.ok(initial.instance);
const { ControlRoomApi, sessionRequestScopeKey, artifactCarrierQueries, admitArtifactFieldCarrier } = entry.namespace;
const sessionScopeKey = sessionRequestScopeKey({ sessionId: owner.session_id, sessionEpoch: owner.session_epoch, requestScopeEpoch: owner.request_scope_epoch });
const api = new ControlRoomApi({ baseUrl: parsed.origin, expectedApiInstance: initial.instance, maxGetRetries: 0,
  binaryDecodeScheduler: task => task.decodeInline(task.buffer),
  fetchImpl: (input, init) => { const request = new Request(input, init); assert.equal(request.method, "GET", "HTTP gate must never materialize or mutate"); return fetch(request, { redirect: "error" }); },
});
const options = () => ({ sessionScopeKey, signal: AbortSignal.timeout(30000) });
async function concurrentReads(reads) {
  const results = await Promise.allSettled(reads);
  const failures = results.filter(result => result.status === "rejected");
  assert.equal(failures.length, 0, failures.map(result => String(result.reason)).join("; "));
  return results.map(result => result.value);
}
const [catalog, quantities] = await concurrentReads([
  api.data.fields.catalog(options(), { stage_id: stage }),
  api.data.quantities.catalog(options(), { stage_id: stage }),
]);
const results = [];
assert.ok(catalog.quantities.some(row => row.quantity_id === "H_ant"));
assert.ok(catalog.quantities.some(row => row.quantity_id === "V_electric"));
if (owner.schema_version === "antenna_closed_loop_stage_output.v2")
  assert.ok(catalog.quantities.some(row => row.quantity_id === "J_charge"), "closed-loop result must expose current density");
assert.equal(new Set(catalog.quantities.map(row => row.quantity_id)).size, catalog.quantities.length, "duplicate historical quantity");
for (const row of catalog.quantities) {
  assert.ok(["H_ant", "J_charge", "V_electric"].includes(row.quantity_id));
  assert.equal(row.state, "stale_complete");
  assert.equal(row.artifact_field_locator.owner.run_id, owner.run_id);
  assert.equal(row.artifact_field_locator.owner.runtime_stage_id, stage);
  assert.equal(row.artifact_field_locator.owner.session_id, owner.session_id);
  assert.equal(row.artifact_field_locator.owner.session_epoch, owner.session_epoch);
  assert.equal(row.artifact_field_locator.owner.request_scope_epoch, owner.request_scope_epoch);
  assert.equal(row.artifact_field_locator.owner.authored_stage_id, owner.stage_id);
  assert.equal(row.artifact_field_locator.owner.object_id, owner.source_object_id);
  assert.equal(row.artifact_field_locator.owner.historical_inspection, true);
  assert.ok(owner.outputs.some(output => output.inspection_ref?.content_digest === row.artifact_field_locator.owner.content_digest), "field does not belong to the inspected immutable output");
  assert.ok(quantities.quantities.some(item => item.id === row.quantity_id && item.unit === row.unit));
  const queries = artifactCarrierQueries(row.artifact_field_locator);
  const meta = await api.data.fields.meta(row.quantity_id, queries.vector, options());
  assert.deepEqual(meta.artifact_field_locator, row.artifact_field_locator);
  const [field, topology] = await concurrentReads([
    api.data.fields.vector(row.quantity_id, queries.vector, options()),
    api.data.domain.topology(options(), queries.geometry),
  ]);
  assert.equal(field.status, "ready"); assert.equal(topology.status, "ready");
  assert.ok(field.data && topology.data && field.responseMetadata && topology.responseMetadata);
  const admitted = admitArtifactFieldCarrier(row.artifact_field_locator, field.data, field.responseMetadata, topology.data, topology.responseMetadata);
  assert.ok(admitted);
  assert.equal(field.data.pointCount, row.artifact_field_locator.sample_count);
  results.push({ quantity: row.quantity_id, samples: field.data.pointCount, indexing: field.data.indexing, unit: row.unit, carrier: row.artifact_field_locator.carrier_id });
}
assert.deepEqual(await inspection(), initial, "owner or API incarnation changed during codec reads");
console.log(JSON.stringify({ status: "passed", scope: "actual HTTP through production facade, FMVP/FMMT decoders and immutable carrier admission; inline decode", stage, concurrentCatalogAndCarrierReads: true, fields: results, sourceModules: modules.size, physicsQualified: false, coldLoadQualified: false, browserWorkerQualified: false }));
