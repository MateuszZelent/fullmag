// Interpreted production guard regression; no compiled unit suite or solver.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = readFileSync(new URL("../src/kernel/api/savedPlanarIdentity.ts", import.meta.url), "utf8");
const guardModule = new vm.SourceTextModule(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
await guardModule.link(() => { throw new Error("Guard must not have runtime dependencies"); });
await guardModule.evaluate();
const { savedPlanarFrameMatches } = guardModule.namespace;
const presets = {
  xy: [[0, 0, 2e-7], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
  xz: [[0, 2e-7, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]],
  yz: [[2e-7, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]],
};
let rejected = 0;
for (const [plane, frame] of Object.entries(presets)) {
  const query = { plane, position_m: 2e-7 };
  const meta = {
    schema_version: "fullmag.persistence.saved_planar.v1", operator: "plane_sample",
    vector_components: ["x", "y", "z"], frame_origin_m: frame[0],
    frame_u_axis: frame[1], frame_v_axis: frame[2], frame_normal: frame[3],
  };
  assert.equal(savedPlanarFrameMatches(meta, query), true, plane);
  const mutations = [
    { schema_version: "fullmag.persistence.saved_planar.v2" },
    { operator: "slab_average" },
    { vector_components: ["z", "y", "x"] },
    { vector_components: ["x", "y"] },
    { vector_components: null },
    { frame_u_axis: frame[2], frame_v_axis: frame[1] },
    { frame_normal: frame[3].map(value => -value) },
    { frame_origin_m: frame[0].map(value => value + 1e-9) },
    { frame_u_axis: [NaN, 0, 0] },
    { frame_normal: [0, 0, Infinity] },
    { frame_v_axis: [] },
    { frame_origin_m: null },
  ];
  for (const mutation of mutations) {
    assert.equal(savedPlanarFrameMatches({ ...meta, ...mutation }, query), false, JSON.stringify(mutation));
    rejected += 1;
  }
  assert.equal(savedPlanarFrameMatches(meta, { ...query, plane: "oblique" }), false);
  assert.equal(savedPlanarFrameMatches(meta, { ...query, position_m: NaN }), false);
}
const client = readFileSync(new URL("../src/kernel/api/ControlRoomApi.ts", import.meta.url), "utf8");
const facade = client.slice(client.indexOf("savedPlanar: async"), client.indexOf("savedFieldGeometry: async"));
assert.ok(facade.indexOf("!savedPlanarFrameMatches(meta, query)") > 0);
assert.ok(facade.indexOf("!savedPlanarFrameMatches(meta, query)") < facade.indexOf("const read = async"));
console.log(`PASS: 3 canonical frames, ${rejected} corrupted responses rejected before binary reads`);
