import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Interpret the actual model; no compiled test target, API mutation, or solver.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "src/modules/inspector/panels/antenna/AntennaSolveTargetsEditorModel.ts");
const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { identifier: path });
await sourceModule.link((specifier) => { throw new Error(`Unexpected runtime dependency: ${specifier}`); });
await sourceModule.evaluate();
const { antennaSolveTargetKey: key, antennaSolveTargetOptions: options, antennaSamplingDomainOptions: samplingOptions, buildAntennaSolveTargetsTransaction: build, acknowledgeAntennaSolveTargetsDraft: ack } = sourceModule.namespace;
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const global = { kind: "global" };
const object = { kind: "object", object_id: "immutable-waveguide" };
const region = { kind: "region", object_id: "immutable-waveguide", region_id: "region-core" };
const solve = {
  id: "solve-basis", source_object_id: "immutable-antenna", current_transport_id: "transport-fixed",
  port_mode_ids: ["port-fixed"], conductor_mesh_policy: "source", solver_policy: "reference",
  field_sampling_domain: global, model: "quasistatic_conduction_biot_savart3d", oersted_realization: "direct_tetra_quadrature",
  outputs: [{ id: "basis-fixed", quantity: "b" }], target_refs: [region, object],
};
const scene = {
  revision: 3, scene: { id: "session-fixed" },
  objects: [
    { id: "immutable-antenna", name: "Arbitrary name", role: "antenna", physics_stack: [] },
    { id: "immutable-waveguide", name: "Visible renamed guide", role: "other", physics_stack: [], regions: [
      { region_id: "region-core", name: "Core", owner_object: "immutable-waveguide" },
      { name: "Not an immutable region ID" },
      { region_id: "region-disabled", name: "Disabled", enabled: false },
      { region_id: "region-other-owner", name: "Foreign", owner_object: "other-object" },
    ] },
  ],
  antenna_field_solve_stages: [solve, { ...solve, id: "untouched-solve", target_refs: [global] }],
  antenna_target_projections: [{ id: "projection-fixed" }], solved_antenna_drives: [{ id: "drive-fixed" }],
  current_transports: [{ name: "transport-fixed", kind: "current_transport", model: "ohmic_poisson" }], study: { stages: [{ stage_id: "run-fixed", kind: "run", until_seconds: "1e-12" }] },
};
const original = JSON.stringify(scene);
check("explicit global/object/region options use canonical immutable identities, no inferred physics", () => {
  const values = options(scene).map((item) => item.key);
  assert.ok(values.includes(key(global)) && values.includes(key(object)) && values.includes(key(region)));
  assert.equal(values.length, 4);
  assert.equal(options(null).length, 1);
  assert.ok(!values.some((item) => item.includes("Not an immutable")));
});
check("full targets including regions persist; transaction changes only solve inventory", () => {
  const result = build(scene, "immutable-antenna", "solve-basis", 3, [region, global, object]);
  assert.equal(result.kind, "merge_patch");
  assert.equal(result.base_revision, 3);
  assert.deepEqual(Object.keys(result.merge_patch), ["antenna_field_solve_stages"]);
  const updated = result.merge_patch.antenna_field_solve_stages;
  assert.deepEqual(updated[0], { ...solve, target_refs: [region, global, object] });
  assert.strictEqual(updated[1], scene.antenna_field_solve_stages[1]);
  assert.equal(JSON.stringify(scene), original);
  updated[0].target_refs[0].region_id = "local-edit";
  assert.equal(scene.antenna_field_solve_stages[0].target_refs[0].region_id, "region-core");
});
check("empty or duplicate targets rejected without silently choosing global", () => {
  assert.throws(() => build(scene, "immutable-antenna", "solve-basis", 3, []), /at least one/);
  assert.throws(() => build(scene, "immutable-antenna", "solve-basis", 3, [object, { ...object }]), /Duplicate/);
});
check("missing object/region and disabled/foreign/unidentified regions rejected", () => {
  for (const target of [{ kind: "object", object_id: "missing" }, { ...region, region_id: "missing" },
    { ...region, region_id: "region-disabled" }, { ...region, region_id: "region-other-owner" }, { ...region, region_id: "Core" }]) {
    assert.throws(() => build(scene, "immutable-antenna", "solve-basis", 3, [target]), /Unavailable/);
  }
});
check("stale/non-integer revision and wrong stage source blocked", () => {
  for (const revision of [2, NaN, Infinity, -1, 3.5]) assert.throws(() => build(scene, "immutable-antenna", "solve-basis", revision, [global]), /Scene changed/);
  assert.throws(() => build(scene, "immutable-waveguide", "solve-basis", 3, [global]), /does not belong/);
  assert.throws(() => build(scene, "immutable-antenna", "missing", 3, [global]), /does not belong/);
  assert.throws(() => build({ ...scene, antenna_field_solve_stages: [solve, solve] }, "immutable-antenna", "solve-basis", 3, [global]), /does not belong/);
});
check("locked or removed source rejected", () => {
  assert.throws(() => build({ ...scene, objects: [{ ...scene.objects[0], locked: true }] }, "immutable-antenna", "solve-basis", 3, [global]), /unlocked/);
  assert.throws(() => build({ ...scene, objects: [] }, "immutable-antenna", "solve-basis", 3, [global]), /unlocked/);
});
check("keys distinguish delimiter-containing IDs without conflating region/object refs", () => {
  assert.notEqual(key({ kind: "region", object_id: "a/b", region_id: "c" }), key({ kind: "region", object_id: "a", region_id: "b/c" }));
  assert.notEqual(key(object), key({ ...region, region_id: object.object_id }));
});
check("sampling options expose only executable domain kinds, not region point clouds", () => {
  assert.ok(samplingOptions(scene).every((option) => option.target.kind !== "region"));
  assert.equal(samplingOptions(scene).length, 3);
});
check("sampling and targets share one transaction while preserving policies, pins, IDs and other stages", () => {
  const result = build(scene, "immutable-antenna", "solve-basis", 3, [region, object], object);
  const next = result.merge_patch.antenna_field_solve_stages;
  assert.deepEqual(next[0], { ...solve, field_sampling_domain: object });
  assert.strictEqual(next[1], scene.antenna_field_solve_stages[1]);
  assert.notStrictEqual(next[0].field_sampling_domain, object);
  assert.equal(JSON.stringify(scene), original);
  assert.throws(() => build(scene, "immutable-antenna", "solve-basis", 3, [object], region), /point-cloud/);
  assert.throws(() => build(scene, "immutable-antenna", "solve-basis", 3, [object], { kind: "object", object_id: "missing" }), /existing/);
});
check("current-driven and unresolved sources refuse vector potential without fallback", () => {
  for (const property of ["conservative_current_source", "external_lead_preparation", "structured_current_closure"]) {
    const copy = structuredClone(scene); copy.current_transports[0][property] = {};
    assert.throws(() => build(copy, "immutable-antenna", "solve-basis", 3, [object], undefined, "vector_potential_solver"), /no automatic fallback/);
    assert.equal(build(copy, "immutable-antenna", "solve-basis", 3, [object], undefined, "direct_tetra_quadrature").merge_patch.antenna_field_solve_stages[0].oersted_realization, "direct_tetra_quadrature");
  }
  assert.throws(() => build({ ...scene, current_transports: [] }, "immutable-antenna", "solve-basis", 3, [object], undefined, "vector_potential_solver"), /unresolved/);
});
check("explicit Oersted choice persists without rewriting policies, targets or other stages", () => {
  const result = build(scene, "immutable-antenna", "solve-basis", 3, solve.target_refs, undefined, "vector_potential_solver");
  assert.deepEqual(result.merge_patch.antenna_field_solve_stages[0], { ...solve, oersted_realization: "vector_potential_solver" });
  assert.strictEqual(result.merge_patch.antenna_field_solve_stages[1], scene.antenna_field_solve_stages[1]);
  assert.equal(JSON.stringify(scene), original);
  for (const realization of ["", "automatic", "2p5d", "unknown"]) {
    assert.throws(() => build(scene, "immutable-antenna", "solve-basis", 3, [object], undefined, realization), /explicit Oersted/);
  }
});
const submitted = { key: "session-epoch|source|solve", baseRevision: 3, dirty: true, targets: [region] };
check("ACK clears only the exact submitted draft and advances its revision", () => {
  assert.deepEqual(ack(submitted, submitted, 4), { ...submitted, baseRevision: 4, dirty: false });
  assert.equal(submitted.baseRevision, 3);
  assert.equal(submitted.dirty, true);
});
check("ACK preserves edits made in flight while rebasing against acknowledged revision", () => {
  const newer = { ...submitted, targets: [region, object] };
  const result = ack(newer, submitted, 4);
  assert.deepEqual(result, { ...newer, baseRevision: 4, dirty: true });
  assert.strictEqual(result.targets, newer.targets);
});
check("stale ACK cannot modify another session/target/rebase or reverted draft", () => {
  for (const current of [null, { ...submitted, key: "different-session" }, { ...submitted, baseRevision: 9 }]) assert.strictEqual(ack(current, submitted, 4), current);
  for (const revision of [3, 2, NaN, Infinity, 4.5]) assert.throws(() => ack(submitted, submitted, revision), /ACK revision/);
});
check("sampling-only in-flight edit survives the older targets ACK", () => {
  const newer = { ...submitted, samplingDomain: object };
  const next = ack(newer, submitted, 4);
  assert.deepEqual(next, { ...newer, baseRevision: 4, dirty: true });
  assert.strictEqual(next.samplingDomain, object);
});
check("Oersted edit made in flight survives an earlier ACK", () => {
  const newer = { ...submitted, oerstedRealization: "vector_potential_solver" };
  assert.deepEqual(ack(newer, submitted, 4), { ...newer, baseRevision: 4, dirty: true });
});
console.log(`PASS ${checks} actual-model checks; browser lifecycle and runtime solve NOT VERIFIED.`);
