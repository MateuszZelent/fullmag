import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root = new URL("../src/", import.meta.url), cache = new Map();
function moduleAt(url) { if (!cache.has(url.href)) cache.set(url.href, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { identifier: url.href })); return cache.get(url.href); }
const entry = moduleAt(new URL("modules/inspector/panels/antenna/AntennaPortComposerModel.ts", root));
await entry.link((name, referrer) => moduleAt(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, root) : new URL(`${name}.ts`, referrer.identifier))); await entry.evaluate();
const { buildAntennaPortCreationTransaction: build, emptyAntennaPortBranch: empty } = entry.namespace;
const ids = ["si", "so", "ri", "ro"];
const scene = { revision: 3, objects: [{ id: "source", role: "antenna" }, { id: "return", role: "conductor" }],
  current_transports: [{ name: "charge", kind: "current_transport", model: "ohmic_poisson", coupling: "one_way", domain: [{ object_id: "source" }, { object_id: "return" }],
    boundaries: ids.map((id, i) => ({ id, kind: "voltage_electrode", surfaces: [{ object_id: i < 2 ? "source" : "return" }] })) }],
  antenna_port_modes: [{ id: "existing", source_object_id: "source" }], antenna_field_solve_stages: [{ id: "solve" }], solved_antenna_drives: [{ id: "drive" }] };
const draft = { key: "scope", baseRevision: 3, dirty: true, id: "new-port", transport: "charge", branches: [
  { ...empty("a"), id: "signal", inletTerminalRef: "si", outletTerminalRef: "so", signedWeight: "1" },
  { ...empty("b"), id: "return", inletTerminalRef: "ri", outletTerminalRef: "ro", signedWeight: "-1" },
] };
let checks = 0; const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check("append preserves every existing port and changes no other collection", () => {
  const before = JSON.stringify(scene), result = build(scene, "source", draft);
  assert.deepEqual(Object.keys(result.merge_patch), ["antenna_port_modes"]); assert.equal(result.base_revision, 3);
  assert.strictEqual(result.merge_patch.antenna_port_modes[0], scene.antenna_port_modes[0]);
  const port = result.merge_patch.antenna_port_modes[1]; assert.equal(port.id, "new-port"); assert.equal(port.schema_version, "antenna_port_mode.v2");
  assert.equal(port.normalization_current_a, 1); assert.deepEqual(port.branches.map(branch => branch.signed_weight), [1, -1]);
  assert.equal(JSON.stringify(scene), before);
});
for (const [name, mutate] of [
  ["duplicate new ID", (s, d) => { d.id = "existing"; }], ["blank ID", (s, d) => { d.id = " "; }],
  ["missing source", s => { s.objects = []; }], ["locked source", s => { s.objects[0].locked = true; }],
  ["duplicate source", s => { s.objects.push({ ...s.objects[0] }); }], ["ambiguous inventory", s => { s.antenna_port_modes.push({ ...s.antenna_port_modes[0] }); }],
  ["missing transport", (s, d) => { d.transport = "missing"; }], ["duplicate transport", s => { s.current_transports.push(structuredClone(s.current_transports[0])); }],
  ["stale revision", (s, d) => { d.baseRevision = 2; }], ["one branch", (s, d) => { d.branches.pop(); }],
  ["blank weight", (s, d) => { d.branches[0].signedWeight = ""; }], ["NaN weight", (s, d) => { d.branches[0].signedWeight = "NaN"; }],
  ["zero weight", (s, d) => { d.branches[0].signedWeight = "0"; }], ["unbalanced weights", (s, d) => { d.branches[1].signedWeight = "-0.5"; }],
  ["missing terminal", (s, d) => { d.branches[0].inletTerminalRef = "missing"; }], ["duplicate terminal", (s, d) => { d.branches[0].inletTerminalRef = "so"; }],
  ["foreign conductor", (s, d) => { d.branches[0].inletTerminalRef = "ri"; }], ["ambiguous terminal", s => { s.current_transports[0].boundaries.push({ ...s.current_transports[0].boundaries[0] }); }],
  ["authored closed loop", s => { s.current_transports[0].structured_current_closure = { kind: "closed_geometry" }; }],
  ["prepared closed loop", s => { s.current_transports[0].conservative_current_source = { kind: "closed_geometry_potential_jump" }; }],
  ["unknown source schema", s => { s.current_transports[0].conservative_current_source = { kind: "unknown" }; }],
]) check(`${name} refuses append`, () => { const s = structuredClone(scene), d = structuredClone(draft); mutate(s, d); assert.throws(() => build(s, "source", d)); });
for (const preparation of [false, true]) check(`${preparation ? "preparation" : "source"} requires exactly one explicit matching drive`, () => {
  const copy = structuredClone(scene), transport = copy.current_transports[0];
  const source = { schema_version: preparation ? "antenna_external_lead_preparation.v1" : "conservative_current_source.v1",
    kind: preparation ? "isolated_branch_straight_stubs" : "external_lead_current", drives: [],
    [preparation ? "extensions" : "terminal_observations"]: ids.map((id, i) => ({ [preparation ? "observation_id" : "id"]: id, object_id: i < 2 ? "source" : "return" })) };
  transport[preparation ? "external_lead_preparation" : "conservative_current_source"] = source;
  assert.throws(() => build(copy, "source", draft), /exactly one/);
  source.drives = [{ id: "authored-drive", port_mode_ref: "new-port" }];
  assert.equal(build(copy, "source", draft).merge_patch.antenna_port_modes.length, 2);
  source.drives.push({ ...source.drives[0] }); assert.throws(() => build(copy, "source", draft), /exactly one/);
});
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production port authoring, not native or science qualification" }));
