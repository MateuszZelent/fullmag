// Interpreted checks of production TypeScript models; no unit-test compilation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { stripTypeScriptTypes } from "node:module";
const root = resolve(import.meta.dirname, "..");
async function sourceModule(path) {
  let source = stripTypeScriptTypes(await readFile(path, "utf8"));
  const matches = [...source.matchAll(/from\s+"([^"]+)"/g)];
  for (const match of matches) {
    const dependency = match[1].startsWith("@/") ? resolve(root, "apps/control-room/src", match[1].slice(2) + ".ts") : resolve(dirname(path), match[1] + ".ts");
    source = source.replace(match[0], `from "${await sourceModule(dependency)}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const model = await import(await sourceModule(resolve(root, "apps/control-room/src/modules/inspector/panels/antenna/AntennaResourceEditorModel.ts")));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function rejects(action, pattern) { assert.throws(action, pattern); checks++; }
const port = { id: "port", schema_version: "antenna_port_mode.v2", source_object_id: "source", current_transport_id: "charge", normalization_current_a: 1, branches: [
  { id: "signal", inlet_terminal_ref: "sin", outlet_terminal_ref: "sout", signed_weight: 1 },
  { id: "return", inlet_terminal_ref: "rin", outlet_terminal_ref: "rout", signed_weight: -1 },
] };
const reference = { kind: "resolved_asset", stage_id: "solve", output_id: "basis", asset_id: "asset", content_digest: "digest" };
const spectrum = { id: "fft", output_id: "fft-output", solution_ref: reference, port_mode_id: "port", target: { kind: "object", object_id: "target" }, transform: "spatial_fft", component: "z", normalization: "integral_si", window: "hann", sampling_plane: { origin_m: [0,0,0], axis_u: [1,0,0], axis_v: [0,1,0], extent_u_m: 1e-6, extent_v_m: 2e-6, sample_count_u: 8, sample_count_v: 16, interpolation: "fem_element", outside_policy: "error" } };
const scene = { revision: 7, scene: { id: "session" }, objects: [{ id: "source" }, { id: "target" }, { id: "other" }],
  antenna_port_modes: [port], current_transports: [{ name: "charge" }],
  antenna_field_solve_stages: ["solve", "solve2"].map((id) => ({ id, source_object_id: "source", current_transport_id: "charge", port_mode_ids: ["port"], outputs: [{ id: "basis", quantity: "H_ant_basis" }] })),
  antenna_target_projections: [{ id: "projection", output_id: "field", solution: reference, target: { kind: "object", object_id: "target" } }],
  solved_antenna_drives: [{ id: "drive", projection_ref: "projection", port_mode_id: "port" }], antenna_spectrum_requests: [spectrum],
};
const pristine = JSON.stringify(scene);
const draft = (kind, id) => model.createAntennaResourceDraft(scene, kind, id, "owner");
const portDraft = draft("port", "port");
const portRequest = model.buildAntennaResourceTransaction(scene, "port", "port", portDraft);
check(JSON.stringify(portRequest.merge_patch.antenna_port_modes[0]) === JSON.stringify(port), "Explicit port weights round trip unchanged");
check(!("current_transports" in portRequest.merge_patch), "Port edit does not actuate currents");
for (const weight of ["", "NaN", "0", "-0.5"]) { const changed = structuredClone(portDraft); changed.branches[1].weight = weight; rejects(() => model.buildAntennaResourceTransaction(scene, "port", "port", changed), /weight|sum|return/); }
const projectionDraft = draft("projection", "projection");
projectionDraft.values.target = '["object","other"]';
const edited = model.buildAntennaResourceTransaction(scene, "projection", "projection", projectionDraft).merge_patch.antenna_target_projections[0];
check(edited.target.object_id === "other", "Target edit applied");
check(JSON.stringify(edited.solution) === JSON.stringify(reference), "Exact immutable asset pins preserved");
projectionDraft.values.rebind = "solve2";
const rebound = model.buildAntennaResourceTransaction(scene, "projection", "projection", projectionDraft).merge_patch.antenna_target_projections[0];
check(rebound.solution.kind === "stage_output" && rebound.solution.stage_id === "solve2" && !("asset_id" in rebound.solution), "Explicit rebind produces pending output, never reuses stale asset pins");
check(!("solved_antenna_drives" in model.buildAntennaResourceTransaction(scene, "projection", "projection", projectionDraft).merge_patch), "No automatic activation change");
const mismatched = structuredClone(scene); mismatched.solved_antenna_drives[0].port_mode_id = "different";
rejects(() => model.buildAntennaResourceTransaction(mismatched, "projection", "projection", projectionDraft), /dependent drive/);
rejects(() => model.buildAntennaResourceTransaction(scene, "projection", "projection", projectionDraft, true), /drive:drive/);
rejects(() => model.buildAntennaResourceTransaction(scene, "port", "port", portDraft, true), /field solve:solve.*drive:drive.*spectrum:fft/);
const orphan = structuredClone(scene); orphan.solved_antenna_drives = [];
check(model.buildAntennaResourceTransaction(orphan, "projection", "projection", projectionDraft, true).merge_patch.antenna_target_projections.length === 0, "Unreferenced projection can be removed without cascade");
const fftDraft = draft("spectrum", "fft"); fftDraft.values.samplesU = "32";
const fft = model.buildAntennaResourceTransaction(scene, "spectrum", "fft", fftDraft).merge_patch.antenna_spectrum_requests[0];
check(fft.sampling_plane.sample_count_u === 32 && fft.sampling_plane.sample_count_v === 16, "Structured FFT request edited");
check(fft.id === "fft" && fft.output_id === "fft-output" && JSON.stringify(fft.solution_ref) === JSON.stringify(reference), "FFT request identity and asset pins retained");
fftDraft.values.rebind = "solve2";
check(model.buildAntennaResourceTransaction(scene, "spectrum", "fft", fftDraft).merge_patch.antenna_spectrum_requests[0].solution_ref.kind === "stage_output", "FFT explicit rebind remains pending");
for (const [name, value, pattern] of [["axisV", "1,0,0", /orthonormal/], ["extentUM", "0", /finite/], ["samplesU", "2", /integer/], ["originM", "0,0", /three/]]) { const changed = structuredClone(fftDraft); changed.values[name] = value; rejects(() => model.buildAntennaResourceTransaction(scene, "spectrum", "fft", changed), pattern); }
const nonuniform = structuredClone(scene); nonuniform.antenna_spectrum_requests[0].transform = "nonuniform_spatial_fft";
rejects(() => model.buildAntennaResourceTransaction(nonuniform, "spectrum", "fft", fftDraft), /source spatial FFT only/);
const stale = { ...fftDraft, baseRevision: 6 }; rejects(() => model.buildAntennaResourceTransaction(scene, "spectrum", "fft", stale), /explicitly rebase/);
const locked = structuredClone(scene); locked.objects[0].locked = true; rejects(() => model.buildAntennaResourceTransaction(locked, "projection", "projection", projectionDraft), /unlocked/);
check(model.acknowledgeAntennaResourceDraft(fftDraft, fftDraft, 8) === null, "ACK clears only unchanged submitted draft");
const duringAck = { ...fftDraft, values: { ...fftDraft.values, samplesU: "64" } };
const retained = model.acknowledgeAntennaResourceDraft(duringAck, fftDraft, 8);
check(retained.values.samplesU === "64" && retained.baseRevision === 8, "Edits made while pending survive ACK");
rejects(() => model.acknowledgeAntennaResourceDraft(fftDraft, fftDraft, 7), /ACK revision/);
check(model.acknowledgeAntennaResourceDraft({ ...duringAck, key: "other-owner" }, fftDraft, 8).key === "other-owner", "Old owner ACK cannot clear current draft");
const prepared = structuredClone(scene); prepared.current_transports[0].external_lead_preparation = { drives: [{ id: "controls", port_mode_ref: "port" }] };
check(model.antennaResourceDependents(prepared, "port", "port").includes("terminal drive:charge/controls"), "Port deletion reports terminal actuation dependents");
const renamed = structuredClone(portDraft); renamed.branches[0].inlet = "new-terminal";
rejects(() => model.buildAntennaResourceTransaction(prepared, "port", "port", renamed), /observation bindings/);
const unrelated = structuredClone(scene); unrelated.current_transports.push({ name: "other-charge", external_lead_preparation: { drives: [] } });
check(model.buildAntennaResourceTransaction(unrelated, "port", "port", renamed).merge_patch.antenna_port_modes[0].branches[0].inlet_terminal_ref === "new-terminal", "Unrelated prepared transport does not lock this port");
const unknownOption = structuredClone(fftDraft); unknownOption.values.component = "magnitude";
rejects(() => model.buildAntennaResourceTransaction(scene, "spectrum", "fft", unknownOption), /Unsupported/);
check(model.buildAntennaResourceTransaction(scene, "spectrum", "fft", fftDraft, true).merge_patch.antenna_spectrum_requests.length === 0, "Unreferenced spectrum request deletion is explicit");
check(JSON.stringify(scene) === pristine, "All transactions preserve source snapshots");
console.log(JSON.stringify({ status: "passed", checks, verification: "interpreted production model; browser and TypeScript build not verified" }));
