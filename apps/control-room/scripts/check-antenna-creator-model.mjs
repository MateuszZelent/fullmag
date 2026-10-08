import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret production factories/details, without compiling unit-test targets.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const commandSource = read("../src/kernel/authoring/geometryLifecycleCommandContributions.ts");
const panelSource = read("../src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx");
const context = vm.createContext({});
function evaluateRange(source, startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Missing production boundary: ${startText}`);
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
}
evaluateRange(commandSource, "function defaultMicrostripAntennaObject(", "function selectCommittedObject(");
evaluateRange(panelSource, "function recordValue(", "function executionValue(");
evaluateRange(panelSource, "function conductorDetails(", "export function AntennaConductorDetails(");
const plain = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const object = vm.runInContext('defaultCpwAntennaObject("immutable-cpw")', context);
const params = object.geometry.geometry_params;
check("CPW has three finite conductor declarations and no magnetic assignment", () => {
  assert.equal(object.id, "immutable-cpw");
  assert.equal(object.geometry.geometry_kind, "CPWAntennaLayout");
  assert.equal(object.magnetization_ref, null);
  assert.equal(object.material_ref, "");
  assert.deepEqual(plain(object.physics_stack), []);
  const ids = ["signal", "ground_left", "ground_right"];
  assert.deepEqual(plain(params.conductors).map((part) => part.id), ids);
  assert.deepEqual(plain(params.stations).map((station) => station.s), [0, 1]);
  for (const station of params.stations) {
    for (const key of ["signal_width_m", "left_gap_m", "right_gap_m", "left_ground_width_m", "right_ground_width_m"]) {
      assert.ok(Number.isFinite(station[key]) && station[key] > 0);
    }
  }
  for (const id of ids) assert.deepEqual(plain(params.terminal_faces[id]), { inlet: "local_u_min", outlet: "local_u_max" });
});
const validationModule = new vm.SourceTextModule(stripTypeScriptTypes(read("../src/shared/domain/physics/antennaStageValidation.ts")), { context });
await validationModule.link(() => { throw new Error("Unexpected validator runtime dependency"); });
await validationModule.evaluate();
check("canonical global target does not falsely qualify an unsolved current source", () => {
  const stage = vm.runInContext('defaultMicrostripFieldSolveStage("immutable-cpw")', context);
  const transport = vm.runInContext('defaultMicrostripCurrentTransport("immutable-cpw", ["signal", "ground_left", "ground_right"])', context);
  const port = vm.runInContext('defaultMicrostripPortMode("immutable-cpw", ["signal", "ground_left", "ground_right"])', context);
  assert.deepEqual(plain(stage.target_refs), [{ kind: "global" }]);
  assert.deepEqual(plain(stage.field_sampling_domain), { kind: "global" });
  const messages = validationModule.namespace.antennaStageValidationMessages(stage, { current_transports: [transport], antenna_port_modes: [port] });
  assert.ok(messages.some((message) => message.includes("mesh-exact ConservativeCurrentView")));
});
check("CPW bounds independently match centered Rz-rotated conductor extent", () => {
  const station = params.stations[0];
  const halfWidth = station.signal_width_m / 2 + station.left_gap_m + station.left_ground_width_m;
  assert.ok(Math.abs(object.geometry.bounds_min[0] + halfWidth) < 1e-20);
  assert.ok(Math.abs(object.geometry.bounds_max[0] - halfWidth) < 1e-20);
  assert.equal(object.geometry.bounds_min[1], -params.length_m / 2);
  assert.equal(object.geometry.bounds_max[1], params.length_m / 2);
  assert.equal(object.geometry.bounds_min[2], -params.thickness_m / 2);
  assert.equal(object.geometry.bounds_max[2], params.thickness_m / 2);
});
check("CPW port weights and all six outward terminals agree with explicit current module", () => {
  const transport = vm.runInContext('defaultMicrostripCurrentTransport("immutable-cpw", ["signal", "ground_left", "ground_right"])', context);
  const port = vm.runInContext('defaultMicrostripPortMode("immutable-cpw", ["signal", "ground_left", "ground_right"])', context);
  assert.equal(port.normalization_current_a, 1);
  assert.equal(port.current_transport_id, transport.name);
  assert.deepEqual(plain(port.branches).map((branch) => branch.signed_weight), [1, -0.5, -0.5]);
  assert.equal(transport.boundaries.length, 7);
  assert.equal(transport.materials[0].material.sigma_Spm, params.conductivity_s_per_m);
  assert.equal(transport.conservative_current_view, undefined);
  const terminals = new Set();
  for (const branch of port.branches) for (const [key, face, y] of [["inlet_terminal_ref", "min", -1], ["outlet_terminal_ref", "max", 1]]) {
    terminals.add(branch[key]);
    const boundary = transport.boundaries.find((entry) => entry.id === branch[key]);
    assert.equal(boundary.kind, "equipotential_current_terminal");
    assert.equal(boundary.surfaces[0].surface_id, `antenna_terminal:${branch.id}:local_u_${face}`);
    assert.deepEqual(plain(boundary.surfaces[0].orientation), [0, y, 0]);
  }
  assert.equal(terminals.size, 6);
});
check("CPW Inspector shows all five station dimensions without microstrip return parameters", () => {
  context.scene = { objects: [plain(object)] };
  const details = vm.runInContext('conductorDetails("immutable-cpw", scene)', context);
  assert.ok(details.rows.some((row) => row.label === "Length"));
  assert.ok(!details.rows.some((row) => row.label === "Return width" || row.label === "Return offset"));
  for (const label of ["Signal width", "Left gap", "Right gap", "Left ground", "Right ground"]) {
    const row = details.rows.find((entry) => entry.label === `1 · ${label}`);
    assert.ok(row && !row.value.includes("unavailable") && row.value.endsWith(" m"));
  }
});
check("microstrip default port and Inspector remain compatible", () => {
  const port = vm.runInContext('defaultMicrostripPortMode("microstrip")', context);
  assert.deepEqual(plain(port.branches).map((branch) => branch.signed_weight), [1, -1]);
  context.scene = { objects: [plain(vm.runInContext('defaultMicrostripAntennaObject("microstrip")', context))] };
  const details = vm.runInContext('conductorDetails("microstrip", scene)', context);
  assert.ok(details.rows.some((row) => row.label === "Return width"));
  assert.ok(!details.rows.find((row) => row.label === "Station 1").value.includes("left gap"));
});
console.log(`PASS ${checks} production creator/detail checks; no backend or physics qualification`);
