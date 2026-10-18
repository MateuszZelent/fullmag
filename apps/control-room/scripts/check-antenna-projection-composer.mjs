import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const root = new URL("../src/modules/inspector/panels/antenna/", import.meta.url);
const cache = new Map();
async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(name.startsWith("@/") ? new URL(`../src/${name.slice(2)}.ts`, import.meta.url) : new URL(`${name}.ts`, root), "utf8")));
  cache.set(name, sourceModule);
  await sourceModule.link(specifier => load(specifier.replace(/^\.\//, "")));
  await sourceModule.evaluate(); return sourceModule;
}
const { composeAntennaProjection: projection, composeAntennaProjectionDrive: combined } = (await load("AntennaProjectionDriveComposerModel")).namespace;
const scene = {
  objects: [{ id: "source" }, { id: "receiver", regions: [{ region_id: "roi", name: "ROI" }] }],
  current_transports: [{ name: "charge" }],
  antenna_field_solve_stages: [{ id: "solve", source_object_id: "source", current_transport_id: "charge", port_mode_ids: ["port"], outputs: [{ id: "basis", quantity: "H_ant_basis" }] }],
  antenna_port_modes: [{ id: "port", source_object_id: "source", current_transport_id: "charge" }],
};
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const target = { kind: "object", object_id: "receiver" };
check("projection has no Run or drive dependency", () => {
  const result = projection(scene, "solve", target);
  assert.equal(JSON.stringify(result), JSON.stringify({ id: "solve:projection:1", solution: { kind: "stage_output", stage_id: "solve", output_id: "basis" }, target, output_id: "solve:projection:1:field" }));
});
check("Global projection is explicit", () => assert.equal(projection(scene, "solve", { kind: "global" }).target.kind, "global"));
check("Region projection preserves owner and region", () => assert.equal(projection(scene, "solve", { kind: "region", object_id: "receiver", region_id: "roi" }).target.region_id, "roi"));
check("source object projection is allowed independently of a magnetic drive", () => assert.equal(projection(scene, "solve", { kind: "object", object_id: "source" }).target.object_id, "source"));
for (const [name, patch] of [
  ["duplicate stage", { antenna_field_solve_stages: [...scene.antenna_field_solve_stages, ...scene.antenna_field_solve_stages] }],
  ["duplicate port", { antenna_port_modes: [...scene.antenna_port_modes, ...scene.antenna_port_modes] }],
  ["missing transport", { current_transports: [] }],
  ["duplicate transport", { current_transports: [{ name: "charge" }, { name: "charge" }] }],
  ["locked source", { objects: [{ id: "source", locked: true }, { id: "receiver" }] }],
  ["duplicate target", { objects: [...scene.objects, { id: "receiver" }] }],
  ["missing source", { objects: [{ id: "receiver" }] }],
  ["mismatched port", { antenna_port_modes: [{ ...scene.antenna_port_modes[0], source_object_id: "other" }] }],
  ["empty basis ID", { antenna_field_solve_stages: [{ ...scene.antenna_field_solve_stages[0], outputs: [{ id: "", quantity: "H_ant_basis" }] }] }],
]) check(`${name} is rejected`, () => assert.throws(() => projection({ ...scene, ...patch }, "solve", target)));
check("missing Region cannot become a different target", () => assert.throws(() => projection(scene, "solve", { kind: "region", object_id: "receiver", region_id: "missing" })));
check("projection IDs and output IDs are both reserved", () => assert.equal(projection({ ...scene, antenna_target_projections: [{ id: "solve:projection:1", output_id: "solve:projection:2:field" }] }, "solve", target).id, "solve:projection:3"));
const withRun = { ...scene, study: { stages: [{ kind: "run", stage_id: "run" }] } };
check("combined path preserves signed peak and exact Run activation", () => {
  const result = combined(withRun, "solve", "receiver", "run", "-0.01", "1e9");
  assert.equal(result.drive.peak_current_a, -0.01); assert.equal(result.drive.activation.stage_ids[0], "run"); assert.equal(result.drive.projection_ref, result.projection.id);
});
check("projection without a drive does not weaken Run validation", () => assert.throws(() => combined(scene, "solve", "receiver", "run", "1", "1e9")));
check("nonfinite amplitude is rejected", () => assert.throws(() => combined(withRun, "solve", "receiver", "run", "Infinity", "1e9")));
check("nonpositive frequency is rejected", () => assert.throws(() => combined(withRun, "solve", "receiver", "run", "1", "0")));
check("composition does not mutate source data", () => { const before = JSON.stringify(scene); projection(scene, "solve", target); assert.equal(JSON.stringify(scene), before); });
check("new drives receive readable names independent of IDs",()=>assert.equal(combined(withRun,"solve","receiver","run","1","1e9").drive.name,"Current drive 1"));
check("default drive name skips existing authored names",()=>assert.equal(combined({...withRun,solved_antenna_drives:[{id:"foreign",name:" Current drive 1 "},{id:"other",name:"Current drive 2"}]},"solve","receiver","run","1","1e9").drive.name,"Current drive 3"));
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production source; no unit test compilation, field solve or qualification" }));
