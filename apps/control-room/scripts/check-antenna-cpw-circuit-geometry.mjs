import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = new URL("../src/shared/domain/geometry/authoredMicrostripGeometry.ts", import.meta.url);
const entry = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(source, "utf8")));
await entry.link(() => { throw new Error("Unexpected geometry dependency"); });
await entry.evaluate();
const build = entry.namespace.buildAuthoredCpwGeometry;
const params = { length_m: 20e-6, thickness_m: 90e-9, conductivity_s_per_m: 3.5e7,
  stations: [0, 1].map(s => ({ s, signal_width_m: 200e-9, left_gap_m: 250e-9, right_gap_m: 300e-9,
    left_ground_width_m: 300e-9, right_ground_width_m: 400e-9 })),
  conductors: ["signal", "ground_left", "ground_right"].map(kind => ({ id: kind, kind })),
  loop: { enabled: true, inlet_connection_length_m: 2e-6, inlet_crossbar_length_m: 200e-9,
    inlet_connection_part_id: "feed", inlet_connection_conductivity_s_per_m: 3.5e7,
    outlet_connection_length_m: 3e-6, outlet_crossbar_length_m: 400e-9,
    outlet_connection_part_id: "closure", outlet_connection_conductivity_s_per_m: 2e7 },
};
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-18, `${actual} differs from ${expected}`);
check("open CPW remains three conductor lofts", () => {
  const mesh = build({ ...params, loop: undefined }, {});
  assert.equal(mesh.parts.length, 3); assert.equal(mesh.positions.length, 72); assert.equal(mesh.indices.length, 108);
});
check("closed GSG contains five parts and four boxes per end", () => {
  const mesh = build(params, {});
  assert.deepEqual(Array.from(mesh.parts, part => part.id), ["signal", "ground_left", "ground_right", "feed", "closure"]);
  assert.equal(mesh.positions.length, 264); assert.equal(mesh.indices.length, 396);
  assert.deepEqual(Array.from(mesh.parts, part => part.indexCount), [36, 36, 36, 144, 144]);
});
check("asymmetric ground widths and both connection extents define the bounds", () => {
  const mesh = build(params, {});
  [-2e-6, -650e-9, -45e-9].forEach((value, axis) => close(mesh.boundsMin[axis], value));
  [23e-6, 800e-9, 45e-9].forEach((value, axis) => close(mesh.boundsMax[axis], value));
});
check("preview preserves the neck gaps instead of filling a bounding box", () => {
  const { positions: p, indices } = build(params, {});
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map(index => p.slice(3 * index, 3 * index + 3));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const metalWidth = 900e-9, span = 1450e-9;
  const expected = 90e-9 * (20e-6 * metalWidth + (2e-6 - 200e-9 + 3e-6 - 400e-9) * metalWidth + (200e-9 + 400e-9) * span);
  assert.ok(Math.abs(volume - expected) <= 1e-10 * expected);
});
check("inner rotation and translation include every connection vertex", () => {
  const mesh = build({ ...params, transform: { rotation_matrix: [[0, 0, 1], [1, 0, 0], [0, 1, 0]], translation_m: [1e-6, -2e-6, 3e-6] } }, {});
  [1e-6 - 45e-9, -4e-6, 3e-6 - 650e-9].forEach((value, axis) => close(mesh.boundsMin[axis], value));
  [1e-6 + 45e-9, 21e-6, 3e-6 + 800e-9].forEach((value, axis) => close(mesh.boundsMax[axis], value));
});
for (const value of [0, 2e-6, 3e-6, NaN]) check(`invalid inlet crossbar ${value} is rejected`, () => {
  assert.throws(() => build({ ...params, loop: { ...params.loop, inlet_crossbar_length_m: value } }, {}), /positive|neck/);
});
for (const id of ["signal", "ground_left", "closure", ""]) check(`invalid connection part ${JSON.stringify(id)} is rejected`, () => {
  assert.throws(() => build({ ...params, loop: { ...params.loop, inlet_connection_part_id: id } }, {}), /IDs|strings/);
});
check("missing or invalid connection conductivity cannot be silently displayed", () => {
  for (const value of [undefined, 0, -1, NaN]) assert.throws(() => build({ ...params, loop: { ...params.loop, outlet_connection_conductivity_s_per_m: value } }, {}), /finite/);
});
check("building the preview does not mutate authored geometry", () => {
  const before = JSON.stringify(params); build(params, {}); assert.equal(JSON.stringify(params), before);
});
console.log(JSON.stringify({ state: "passed", checks, scope: "production authored GSG geometry; no solver mesh or browser/WebGL qualification" }));
