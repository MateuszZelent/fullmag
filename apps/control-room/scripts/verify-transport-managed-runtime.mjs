const baseUrl = process.env.FULLMAG_MANAGED_RUNTIME_URL;
if (!baseUrl) {
  throw new Error("FULLMAG_MANAGED_RUNTIME_URL is required; managed transport proof cannot be replaced by a fixture.");
}

const timeoutMs = Number(process.env.FULLMAG_MANAGED_RUNTIME_TIMEOUT_MS ?? 180_000);
const headers = { "content-type": "application/json" };
const requiredQuantities = [{ id: "J_charge", components: 3 }, { id: "spin_potential", components: 3 }, { id: "spin_current_tensor", components: 9 }, { id: "torque_transport", components: 3 }, { id: "H_oe", components: 3 }];

async function json(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), { ...init, headers: { ...headers, ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

const currentTransports = await json("/v2/sessions/current/model/current-transports");
const spinTransports = await json("/v2/sessions/current/model/spin-transports");
if (!Array.isArray(currentTransports.items) || currentTransports.items.length === 0 || !Array.isArray(spinTransports.items) || spinTransports.items.length === 0) {
  throw new Error("Managed proof requires an active transport-enabled scene with charge and spin transport resources.");
}
const transportVersions = spinTransports.items.map((item) => ({
  constitutive_version: item.constitutive_version,
  id: item.id,
  operator_version: item.solver?.operator_version,
}));
if (transportVersions.some((item) => !item.id || !item.constitutive_version || !item.operator_version)) {
  throw new Error(`Managed transport provenance is incomplete: ${JSON.stringify(transportVersions)}`);
}
const sceneIdentity = { current_ids: currentTransports.items.map((item) => item.name), current_revision: currentTransports.scene_revision, spin_ids: spinTransports.items.map((item) => item.id), spin_revision: spinTransports.scene_revision };
const beforeRevisions = new Map();
for (const quantity of requiredQuantities) {
  const response = await fetch(new URL(`/v2/sessions/current/data/fields/${encodeURIComponent(quantity.id)}/meta`, baseUrl));
  if (response.status === 404) beforeRevisions.set(quantity.id, 0);
  else {
    if (!response.ok) throw new Error(`Pre-command field snapshot failed for ${quantity.id} (${response.status}).`);
    const meta = await response.json();
    beforeRevisions.set(quantity.id, Number(meta.field_revision ?? 0));
  }
}

const submitted = await json("/v2/sessions/current/simulation/commands", {
  method: "POST",
  body: JSON.stringify({ kind: "solve" }),
});
if (!submitted?.accepted || !submitted.command_id) {
  throw new Error(`Managed runtime rejected solve command: ${JSON.stringify(submitted)}`);
}

const deadline = Date.now() + timeoutMs;
let detail = null;
while (Date.now() < deadline) {
  detail = await json(`/v2/sessions/current/simulation/commands/${encodeURIComponent(submitted.command_id)}`);
  const state = String(detail?.completion_status ?? "").toLowerCase();
  if (["completed", "succeeded", "success"].includes(state)) break;
  if (["failed", "rejected", "cancelled", "canceled"].includes(state)) {
    throw new Error(`Managed command failed: ${JSON.stringify(detail)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const finalState = String(detail?.completion_status ?? "").toLowerCase();
if (!["completed", "succeeded", "success"].includes(finalState)) {
  throw new Error(`Managed command did not complete within ${timeoutMs} ms: ${JSON.stringify(detail)}`);
}
if (detail.command_id !== submitted.command_id || !detail.run_id || !detail.stage_id) {
  throw new Error(`Managed completion lacks command/run/stage identity correlation: ${JSON.stringify(detail)}`);
}

const artifactRefs = Array.isArray(detail.artifact_refs) ? detail.artifact_refs.filter((value) => typeof value === "string" && value.length > 0) : [];
async function verifyQuantity({ id: quantityId, components: expectedComponents }) {
 const meta = await json(`/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/meta`);
 if (meta.quantity_id !== quantityId || meta.components !== expectedComponents || !Number.isInteger(meta.field_revision) || meta.field_revision <= (beforeRevisions.get(quantityId) ?? 0)) throw new Error(`Managed transport field was not republished by this command: before=${beforeRevisions.get(quantityId) ?? 0}, after=${JSON.stringify(meta)}`);
 if (meta.command_id !== submitted.command_id || meta.run_id !== detail.run_id || meta.stage_id !== detail.stage_id) throw new Error(`Managed field lacks command/run/stage provenance correlation: ${JSON.stringify(meta)}`);
 const vectorResponse = await fetch(new URL(`/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/samples/vector`, baseUrl));
 if (!vectorResponse.ok) throw new Error(`Managed transport field ${quantityId} fetch failed (${vectorResponse.status}).`);
 const buffer = await vectorResponse.arrayBuffer();
const view = new DataView(buffer);
const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
if (magic !== "FMVP") throw new Error(`Managed field vector has invalid magic: ${magic}`);
const version = view.getUint8(4);
const components = view.getUint8(6);
const metadataLength = version === 3 ? view.getUint32(8, true) : 0;
const valueCount = view.getUint32(12, true);
if (![2, 3].includes(version) || components !== expectedComponents || valueCount < components) {
  throw new Error(`Managed field vector header mismatch: version=${version}, components=${components}, values=${valueCount}`);
}
const values = new Float64Array(buffer, 48 + metadataLength, valueCount);
const sample = Array.from(values.subarray(0, Math.min(valueCount, expectedComponents * 4)));
if (sample.length < expectedComponents || sample.some((value) => !Number.isFinite(value))) {
  throw new Error(`Managed field sample is not finite: ${JSON.stringify(sample)}`);
}
 return { components, quantityId, revision: meta.field_revision, sampleCount: sample.length, valueCount };
}
const proofs = [];
for (const quantity of requiredQuantities) proofs.push(await verifyQuantity(quantity));
if (artifactRefs.length === 0) throw new Error("Managed command exposes no command-correlated transport artifact_refs.");

console.log(`Managed transport runtime proof passed: command=${submitted.command_id}, completion=${finalState}, scene=${JSON.stringify(sceneIdentity)}, artifacts=${artifactRefs.length}, modules=${JSON.stringify(transportVersions)}, fields=${JSON.stringify(proofs)}.`);
