import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = new URL("../src/", import.meta.url), cache = new Map();
async function load(url) {
  const key = url.href;
  if (cache.has(key)) return cache.get(key);
  const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")));
  cache.set(key, sourceModule);
  await sourceModule.link(name => load(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, root) : new URL(`${name}.ts`, url)));
  await sourceModule.evaluate(); return sourceModule;
}
const base = "modules/inspector/panels/antenna/";
const model = (await load(process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL(`${base}SolvedAntennaDriveEditorModel.ts`, root))).namespace;
const preview = (await load(new URL(`${base}AntennaDrivePreviewModel.ts`, root))).namespace;
const drive = { id: "drive", name: "Drive", projection_ref: "projection", port_mode_id: "port", peak_current_a: 0.01,
  waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0, offset: 0 }, time_origin: "stage_local", activation: { kind: "stage_ids", stage_ids: ["run"] } };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check("user-facing name changes without changing immutable identity", () => {
  const result=model.buildSolvedDrive(drive,{...model.solvedDriveDraft(drive),name:"  RF to waveguide  "});
  assert.equal(result.name,"RF to waveguide"); assert.equal(result.id,drive.id); assert.equal(result.projection_ref,drive.projection_ref); assert.equal(result.port_mode_id,drive.port_mode_id);
});
check("unrelated edits preserve an existing name verbatim", () => {
  const legacy={...drive,name:"  Existing display name  "};
  const result=model.buildSolvedDrive(legacy,{...model.solvedDriveDraft(legacy),peakCurrentA:"0.02"});
  assert.equal(result.name,legacy.name); assert.equal(result.peak_current_a,0.02);
});
check("projection and port are authored together while drive ID stays immutable",()=>{
  const result=model.buildSolvedDrive(drive,{...model.solvedDriveDraft(drive),projectionRef:"other-projection",portModeId:"other-port"});
  assert.equal(result.id,drive.id);assert.equal(result.projection_ref,"other-projection");assert.equal(result.port_mode_id,"other-port");
});
check("late ACK preserves a newer projection/port pair",()=>{
  const submitted=model.solvedDriveDraft(drive),later={...submitted,projectionRef:"later-projection",portModeId:"later-port"};
  const ack=model.acknowledgeSolvedDriveDraft({id:drive.id,draft:later,dirtyKeys:["projectionRef","portModeId"],editedAgainst:{projectionRef:submitted.projectionRef,portModeId:submitted.portModeId}},drive.id,submitted,submitted,2);
  assert.equal(ack.draft.projectionRef,later.projectionRef);assert.equal(ack.draft.portModeId,later.portModeId);
});
check("blank drive name is rejected",()=>assert.throws(()=>model.buildSolvedDrive(drive,{...model.solvedDriveDraft(drive),name:"  "}),/name is required/));
check("late ACK preserves a newer display name",()=>{
  const submitted=model.solvedDriveDraft(drive), later={...submitted,name:"Later name"};
  const result=model.acknowledgeSolvedDriveDraft({id:drive.id,draft:later,dirtyKeys:["name"],editedAgainst:{name:submitted.name}},drive.id,submitted,submitted,2);
  assert.equal(result.draft.name,"Later name"); assert.equal(JSON.stringify(result.dirtyKeys),'["name"]');
});
check("textual point cells compile into canonical numeric pairs", () => {
  const authored = model.buildSolvedDrive(drive, { ...model.solvedDriveDraft(drive), waveformKind: "piecewise_linear", piecewisePoints: '[["0","-1."],["1e-9","2.5"]]' });
  assert.equal(JSON.stringify(authored.waveform.points), "[[0,-1],[1e-9,2.5]]");
});
check("time origin survives draft and authored update", () => { const draft = { ...model.solvedDriveDraft(drive), timeOrigin: "absolute" }; assert.equal(model.buildSolvedDrive(drive, draft).time_origin, "absolute"); });
check("unknown clock is rejected", () => assert.throws(() => model.buildSolvedDrive(drive, { ...model.solvedDriveDraft(drive), timeOrigin: "guess" }), /time origin/));
check("zero current remains a valid disabled drive", () => close(model.buildSolvedDrive(drive, { ...model.solvedDriveDraft(drive), peakCurrentA: "0" }).peak_current_a, 0));
check("signed current is not converted to RMS", () => { const points = preview.sampleAntennaDrive({ ...drive, peak_current_a: -0.01 }, 0, 1e-9); close(points.find(p => p.x === 2.5e-10).y, -0.01); });
check("phase and offset use the shared waveform convention", () => close(preview.sampleAntennaDrive({ ...drive, waveform: { ...drive.waveform, phase_rad: Math.PI / 2, offset: 0.5 } }, 0, 1e-9)[0].y, 0.015));
check("constant current is constant", () => assert.ok(preview.sampleAntennaDrive({ ...drive, waveform: { kind: "constant" } }, 0, 1e-9).every(p => p.y === 0.01)));
check("narrow pulse keeps both exact one-sided boundaries", () => {
  const pulse = { ...drive, waveform: { kind: "pulse", t_on: 1e-12, t_off: 1.01e-12 } };
  const points = preview.sampleAntennaDrive(pulse, 0, 1e-9);
  assert.equal(JSON.stringify(points.filter(p => p.x === 1e-12).map(p => p.y)), "[0,0.01]");
  assert.equal(JSON.stringify(points.filter(p => p.x === 1.01e-12).map(p => p.y)), "[0.01,0]");
  assert.ok(points.every((p,i) => i === 0 || p.x >= points[i-1].x));
});
check("piecewise knots and clamped end values are preserved", () => {
  const points = preview.sampleAntennaDrive({ ...drive, waveform: { kind: "piecewise_linear", points: [[1e-10, 2], [1.001e-10, -3], [2e-10, 0]] } }, 0, 1e-9);
  close(points[0].y, 0.02); close(points.find(p => p.x === 1.001e-10).y, -0.03); close(points.at(-1).y, 0);
});
check("sinc center and its amplitude remain authored", () => { const w = { kind: "sinc_pulse", cutoff_hz: 1e9, t0: 2e-10, amplitude: 3 }; const points = preview.sampleAntennaDrive({ ...drive, waveform: w }, 0, 1e-9); close(points.find(p => p.x === w.t0).y, 0.03); });
for (const [name, from, to] of [["blank interval", 0, 0], ["reversed interval", 1, 0], ["infinite interval", 0, Infinity], ["overflowing interval", -1e308, 1e308]]) check(name, () => assert.throws(() => preview.sampleAntennaDrive(drive, from, to), /range/));
check("oversized frequency range is rejected instead of aliased", () => assert.throws(() => preview.sampleAntennaDrive(drive, 0, 100e-9), /16 oscillations/));
check("sample budget is explicit and enforced", () => assert.ok(preview.sampleAntennaDrive(drive, 0, 16e-9).length <= preview.MAX_DRIVE_PREVIEW_POINTS));
check("too many piecewise knots do not get silently truncated", () => assert.throws(() => preview.sampleAntennaDrive({ ...drive, waveform: { kind: "piecewise_linear", points: Array.from({length:513},(_,i)=>[i,1]) } }, 0, 512), /512 authored knots/));
check("overflowing current is rejected", () => assert.throws(() => preview.sampleAntennaDrive({ ...drive, peak_current_a: 1e308, waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: Math.PI / 2, offset: 10 } }, 0, 1e-9), /overflow/));
check("ACK cannot change the projection binding", () => assert.throws(() => model.resolveCommittedSolvedDriveScene({ scene_revision: 2, committed_scene: { revision: 2, scene: { id: "scene" }, solved_antenna_drives: [{ ...drive, projection_ref: "foreign" }] } }, drive, "scene", 1), /submitted binding/));
check("ACK cannot change the time origin", () => assert.throws(() => model.resolveCommittedSolvedDriveScene({ scene_revision: 2, committed_scene: { revision: 2, scene: { id: "scene" }, solved_antenna_drives: [{ ...drive, time_origin: "absolute" }] } }, drive, "scene", 1), /parameters/));
check("ACK preserves later unsaved clock edits", () => { const draft=model.solvedDriveDraft(drive); const ack=model.acknowledgeSolvedDriveDraft({id:drive.id,draft:{...draft,timeOrigin:"absolute"},dirtyKeys:["timeOrigin"],editedAgainst:{timeOrigin:"stage_local"}},drive.id,draft,draft); assert.equal(ack.draft.timeOrigin,"absolute"); });
check("409 conflict blocks both save paths until explicit rebase", () => {
  for (const phase of ["conflict", "refreshing", "refetched"]) assert.ok(model.solvedDriveSaveBlockReason(null,0,phase));
  assert.equal(model.solvedDriveSaveBlockReason(null,0,"rebased"),undefined);
  assert.ok(model.solvedDriveSaveBlockReason(null,1,"rebased"));
  assert.equal(model.solvedDriveSaveBlockReason("Invalid frequency",0,"rebased"),"Invalid frequency");
});
check("incomplete numeric text survives the draft reader", () => assert.equal(JSON.stringify(model.readPiecewiseDrivePoints('[["0","1."],["1e-","-"]]')), '[["0","1."],["1e-","-"]]'));
check("numeric legacy point drafts remain supported", () => assert.equal(JSON.stringify(model.buildPiecewiseDrivePoints('[[0,0],[1e-9,1]]')), '[[0,0],[1e-9,1]]'));
for (const [name, raw] of [["null cell", '[[null,0],[1,1]]'], ["boolean cell", '[[false,0],[1,1]]'], ["object cell", '[[{},0],[1,1]]'], ["missing cell", '[[0],[1,1]]'], ["malformed point data", 'not-json']]) check(name, () => assert.throws(() => model.readPiecewiseDrivePoints(raw), /draft/));
for (const [name, raw] of [["blank time", '[["","0"],["1","1"]]'], ["blank multiplier", '[["0",""],["1","1"]]'], ["incomplete exponent", '[["0","0"],["1e-","1"]]'], ["infinite multiplier", '[["0","0"],["1","Infinity"]]'], ["duplicate times", '[["0","0"],["0","1"]]'], ["reversed times", '[["1","0"],["0","1"]]'], ["too few points", '[["0","0"]]']]) check(name, () => assert.throws(() => model.buildPiecewiseDrivePoints(raw)));
check("per-cell errors identify the order violation without sorting", () => {
  const rows=model.readPiecewiseDrivePoints('[["1","0"],["0","1"]]'); const before=JSON.stringify(rows);
  assert.match(model.piecewiseDrivePointErrors(rows)[1][0], /strictly increasing/); assert.equal(JSON.stringify(rows),before);
});
check("preview knot limit never limits authored waveform size", () => assert.equal(model.buildPiecewiseDrivePoints(JSON.stringify(Array.from({length:513},(_,i)=>[String(i),"1"]))).length,513));
check("late ACK preserves a newly added incomplete point", () => {
  const submitted={...model.solvedDriveDraft(drive),waveformKind:"piecewise_linear",piecewisePoints:'[["0","0"],["1","1"]]'};
  const later={...submitted,piecewisePoints:'[["0","0"],["1","1"],["1e-","0"]]'};
  const ack=model.acknowledgeSolvedDriveDraft({id:drive.id,draft:later,dirtyKeys:["waveformKind","piecewisePoints"],editedAgainst:{piecewisePoints:submitted.piecewisePoints}},drive.id,submitted,{...submitted,piecewisePoints:'[[0,0],[1,1]]'});
  assert.equal(ack.draft.piecewisePoints,later.piecewisePoints); assert.equal(JSON.stringify(ack.dirtyKeys),'["piecewisePoints"]');
});
check("ACK base prevents a point-count rollback while the resource hook catches up", () => {
  const old={...model.solvedDriveDraft(drive),waveformKind:"piecewise_linear",piecewisePoints:'[[0,0],[1,1]]'};
  const submitted={...old,piecewisePoints:'[["0","0"],["1","1"],["2","0"]]'}, committed={...submitted,piecewisePoints:'[[0,0],[1,1],[2,0]]'};
  const local=model.acknowledgeSolvedDriveDraft({id:drive.id,draft:submitted,dirtyKeys:["piecewisePoints"],editedAgainst:{piecewisePoints:old.piecewisePoints}},drive.id,submitted,committed,10);
  assert.equal(local.dirtyKeys.length,0);
  assert.equal(model.resolvedSolvedDriveDraftBase(old,local,9).piecewisePoints,committed.piecewisePoints);
  assert.equal(model.resolvedSolvedDriveDraftBase(old,local,null).piecewisePoints,committed.piecewisePoints);
  const newer={...committed,piecewisePoints:'[[0,1],[1,1],[2,1]]'};
  assert.equal(model.resolvedSolvedDriveDraftBase(newer,local,11),newer);
});
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production drive/preview/evaluator; no unit test compilation or solver qualification" }));
