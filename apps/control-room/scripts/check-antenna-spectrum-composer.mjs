import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const source = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL("../src/modules/inspector/panels/antenna/AntennaSpectrumComposerModel.ts", import.meta.url);
const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(source, "utf8")));
const vectors = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("../src/modules/inspector/panels/antenna/AntennaSamplingPlaneFieldsModel.ts", import.meta.url), "utf8")));
await vectors.link(() => { throw new Error("Unexpected vector-model dependency"); }); await vectors.evaluate();
await sourceModule.link(name => { assert.equal(name, "./AntennaSamplingPlaneFieldsModel"); return vectors; }); await sourceModule.evaluate();
const { composeAntennaSpectrumRequest: compose, acknowledgeAntennaSpectrumDraft: acknowledge, emptyAntennaSpectrumDraft, MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT: limit } = sourceModule.namespace;
const scene = {
  objects: [{ id: "source" }, { id: "receiver" }], current_transports: [{ name: "charge" }],
  antenna_field_solve_stages: [{ id: "solve", source_object_id: "source", current_transport_id: "charge", port_mode_ids: ["port"], outputs: [{ id: "basis", quantity: "H_ant_basis" }] }],
  antenna_port_modes: [{ id: "port", source_object_id: "source", current_transport_id: "charge" }],
};
const draft = { ...emptyAntennaSpectrumDraft, targetObjectId: "receiver", originM: "0, 0, 0", axisU: "1 0 0", axisV: "0 1 0", extentUM: "2e-7", extentVM: "1e-7", samplesU: "16", samplesV: "8", windowKind: "hann" };
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check("textual XYZ fields produce canonical numeric SI vectors",()=>{
  const result=compose(scene,"solve",{...draft,originM:'["0","1e-9","-2e-9"]',axisU:'["1","0","0"]',axisV:'["0","1","0"]'});
  assert.equal(JSON.stringify(result.sampling_plane.origin_m),'[0,1e-9,-2e-9]');
});
check("oversized FFT is rejected before a transaction reaches the runtime", () => assert.throws(() => compose(scene, "solve", { ...draft, samplesU: "5001", samplesV: "2000" }), /runtime limit/));
check("frontend sample limit matches the actual native runtime contract", () => {
  const native = readFileSync(new URL("../../../crates/fullmag-runner/src/antenna_spectrum.rs", import.meta.url), "utf8");
  const declared = native.match(/const MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT: usize = ([0-9_]+);/);
  assert.ok(declared); assert.equal(limit, Number(declared[1].replaceAll("_", "")));
});
check("valid structured request preserves canonical SI plane, source, port and observable", () => {
  const result = compose(scene, "solve", draft);
  assert.equal(result.transform, "spatial_fft"); assert.equal(result.solution_ref.stage_id, "solve"); assert.equal(result.solution_ref.output_id, "basis"); assert.equal(result.port_mode_id, "port");
  assert.equal(result.target.object_id, "receiver"); assert.equal(result.sampling_plane.extent_u_m, 2e-7); assert.equal(result.sampling_plane.sample_count_u, 16);
  assert.equal(result.window, "hann"); assert.equal(result.component, "x"); assert.equal(result.output_id, `${result.id}:output`); assert.ok(!("peak_current_a" in result));
});
check("exact native budget boundary is allowed without allocation", () => assert.equal(compose(scene, "solve", { ...draft, samplesU: "5000", samplesV: "2000" }).sampling_plane.sample_count_u, 5000));
for (const [name, patch] of [
  ["duplicate stage", { antenna_field_solve_stages: [...scene.antenna_field_solve_stages, ...scene.antenna_field_solve_stages] }],
  ["duplicate port", { antenna_port_modes: [...scene.antenna_port_modes, ...scene.antenna_port_modes] }],
  ["foreign port", { antenna_port_modes: [{ ...scene.antenna_port_modes[0], source_object_id: "other" }] }],
  ["missing source", { objects: [{ id: "receiver" }] }],
  ["locked source", { objects: [{ id: "source", locked: true }, { id: "receiver" }] }],
  ["duplicate source", { objects: [...scene.objects, { id: "source" }] }],
  ["duplicate receiver", { objects: [...scene.objects, { id: "receiver" }] }],
  ["missing transport", { current_transports: [] }],
  ["duplicate transport", { current_transports: [...scene.current_transports, ...scene.current_transports] }],
  ["empty output ID", { antenna_field_solve_stages: [{ ...scene.antenna_field_solve_stages[0], outputs: [{ id: "", quantity: "H_ant_basis" }] }] }],
  ["ambiguous output ID", { antenna_field_solve_stages: [{ ...scene.antenna_field_solve_stages[0], outputs: [{ id: "basis", quantity: "H_ant_basis" }, { id: "basis", quantity: "other" }] }] }],
]) check(`${name} cannot author a source FFT`, () => assert.throws(() => compose({ ...scene, ...patch }, "solve", draft)));
for (const [name, patch] of [
  ["unknown window", { windowKind: "unknown" }], ["unknown normalization", { normalization: "unknown" }],
  ["unknown component", { component: "unknown" }], ["unbound transverse component", { component: "transverse" }],
  ["unknown outside policy", { outsidePolicy: "unknown" }], ["zero extent", { extentUM: "0" }],
  ["nonfinite origin", { originM: "Infinity 0 0" }], ["parallel axes", { axisV: "1 0 0" }],
  ["nonunit axis", { axisU: "2 0 0" }], ["undersampled Hann window", { samplesU: "2" }],
  ["fractional grid count", { samplesV: "3.5" }], ["missing receiver", { targetObjectId: "missing" }],
]) check(`${name} is rejected`, () => assert.throws(() => compose(scene, "solve", { ...draft, ...patch })));
check("rectangular window accepts two samples per axis", () => assert.equal(compose(scene, "solve", { ...draft, windowKind: "rectangular", samplesU: "2", samplesV: "2" }).sampling_plane.sample_count_u, 2));
check("receiver lock does not impose an unsupported editing restriction", () => assert.equal(compose({ ...scene, objects: [{ id: "source" }, { id: "receiver", locked: true }] }, "solve", draft).target.object_id, "receiver"));
check("source may itself be the FFT receiver without magnetic physics", () => assert.equal(compose(scene, "solve", { ...draft, targetObjectId: "source" }).target.object_id, "source"));
check("request IDs and output IDs both prevent overwrite", () => assert.equal(compose({ ...scene, antenna_spectrum_requests: [{ id: "solve:spectrum:1", output_id: "solve:spectrum:2:output" }] }, "solve", draft).id, "solve:spectrum:3"));
const submitted = { key: "scope|solve", baseRevision: 2, dirty: true, values: draft };
check("unchanged ACK clears only dirty state and keeps visible values", () => { const result = acknowledge(submitted, submitted, 3); assert.equal(result.dirty, false); assert.equal(result.baseRevision, 3); assert.equal(result.values, draft); });
check("edits after submission survive ACK and acquire its base revision", () => { const later = { ...submitted, values: { ...draft, samplesU: "32" } }; const result = acknowledge(later, submitted, 3); assert.equal(result.dirty, true); assert.equal(result.baseRevision, 3); assert.equal(result.values.samplesU, "32"); });
check("ACK cannot resurrect an old scope or cleared draft", () => { const other = { ...submitted, key: "other-scope|solve" }; assert.equal(acknowledge(other, submitted, 3), other); assert.equal(acknowledge(null, submitted, 3), null); });
check("composition never mutates source collections", () => { const before = JSON.stringify(scene); compose(scene, "solve", draft); assert.equal(JSON.stringify(scene), before); });
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production source and native sample budget; no unit test compilation or scientific FFT execution" }));
