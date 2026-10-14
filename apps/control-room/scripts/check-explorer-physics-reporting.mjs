import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Execute the production adapter and its real, fixed dependency graph in memory.
// No TypeScript compiler, emitted bundle, browser or solver is involved.
const paths = {
  adapter: "src/modules/explorer/builders/sceneModelTreeAdapter.ts",
  "@/kernel/selection/selectionTypes": "src/kernel/selection/selectionTypes.ts",
  "@/shared/domain/physics/torqueUnits": "src/shared/domain/physics/torqueUnits.ts",
  "@/shared/domain/study/studyStageSource": "src/shared/domain/study/studyStageSource.ts",
  "@/shared/domain/mesh/regionMeshLifecycle": "src/shared/domain/mesh/regionMeshLifecycle.ts",
  "@/kernel/visualization/visualizationDisplayResolution": "src/kernel/visualization/visualizationDisplayResolution.ts",
};
const context = vm.createContext({});
const modules = new Map(Object.entries(paths).map(([id, path]) => [id,
  new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), {
    context, identifier: path,
  }),
]));
const adapter = modules.get("adapter");
await adapter.link((specifier) => {
  const dependency = modules.get(specifier);
  assert.ok(dependency, `Unexpected production dependency: ${specifier}`);
  return dependency;
});
await adapter.evaluate();
const snapshotFromScene = adapter.namespace.modelTreeSnapshotFromScene;
const kind = (interactions, id) => interactions.find((item) => item.id === id);
const plain = (value) => structuredClone(value);
const magnet = (id, extra = {}) => ({ id, name: id, ...extra });
let cases = 0;
function inspect(scene) {
  const before = structuredClone(scene);
  const snapshot = plain(snapshotFromScene(scene));
  assert.deepStrictEqual(scene, before, "reporting must not mutate the scene");
  cases += 1;
  return snapshot;
}

// Material presence is not activation. These are authored values, not an epsilon.
for (const value of [undefined, null, 0, -0, "0", " 0 ", "", "invalid", "0x10", "0b10", NaN, Infinity]) {
  const snapshot = inspect({
    materials: [{ id: "mat", properties: { Dind: value, Dbulk: value } }],
    objects: [magnet("film", { material_ref: "mat" })],
  });
  for (const id of ["interfacial_dmi", "bulk_dmi"]) {
    assert.equal(kind(snapshot.objects[0].physicsInteractions, id), undefined);
    assert.equal(kind(snapshot.physicsInteractions, id), undefined);
  }
}
for (const value of [0.001, -0.001, "0.001", " -0.001 "]) {
  const snapshot = inspect({
    materials: [{ id: "mat", properties: { Dind: value, Dbulk: value } }],
    objects: [magnet("film", { material_ref: "mat" })],
  });
  for (const id of ["interfacial_dmi", "bulk_dmi"]) {
    assert.deepEqual(kind(snapshot.objects[0].physicsInteractions, id), kind(snapshot.physicsInteractions, id));
    assert.equal(kind(snapshot.physicsInteractions, id).enabledCount, 1);
    assert.equal(kind(snapshot.physicsInteractions, id).objectCount, 1);
  }
}
for (const id of ["interfacial_dmi", "bulk_dmi", "uniaxial_anisotropy", "exchange", "demag"]) {
  for (const lastEnabled of [true, false]) {
    const snapshot = inspect({
      materials: [{ id: "mat", properties: { Dind: 0.002, Dbulk: 0.002 } }],
      objects: [magnet("film", { material_ref: "mat", physics_stack: [
        { kind: id, enabled: !lastEnabled },
        { kind: ` ${id} `, enabled: lastEnabled },
        { kind: "unknown_physics", enabled: true },
      ] })],
    });
    const resolved = kind(snapshot.objects[0].physicsInteractions, id);
    assert.equal(resolved.enabledCount, lastEnabled ? 1 : 0);
    assert.equal(resolved.objectCount, 1);
    assert.deepEqual(kind(snapshot.physicsInteractions, id), resolved);
    assert.equal(kind(snapshot.physicsInteractions, "unknown_physics"), undefined);
  }
}
const nonCanonicalKeys = inspect({
  materials: [{ id: "mat", properties: { dind: 0.001, dbulk: 0.001 } }],
  objects: [magnet("film", { material_ref: "mat" })],
});
assert.equal(kind(nonCanonicalKeys.physicsInteractions, "interfacial_dmi"), undefined);
assert.equal(kind(nonCanonicalKeys.physicsInteractions, "bulk_dmi"), undefined);

const explicitZero = inspect({
  materials: [{ id: "mat", properties: { Dind: 0, Dbulk: 0 } }],
  objects: [magnet("film", { material_ref: "mat", physics_stack: [
    { kind: "interfacial_dmi", enabled: true, params: { dind: 0 } },
    { kind: "bulk_dmi", enabled: false, params: { dbulk: 0 } },
  ] })],
});
assert.equal(kind(explicitZero.physicsInteractions, "interfacial_dmi").enabledCount, 1);
assert.equal(kind(explicitZero.physicsInteractions, "bulk_dmi").enabledCount, 0);
const globallyDisabled = inspect({
  study: { exchange_enabled: false, demag_enabled: false },
  objects: [magnet("local-enabled", { physics_stack: [
    { kind: "exchange", enabled: true },
    { kind: "demag", enabled: true },
  ] })],
});
for (const id of ["exchange", "demag"]) {
  assert.equal(kind(globallyDisabled.objects[0].physicsInteractions, id).enabledCount, 0);
  assert.equal(kind(globallyDisabled.physicsInteractions, id).enabledCount, 0);
}

const mixed = inspect({
  study: { exchange_enabled: false, demag_enabled: true },
  materials: [{ id: "mat", properties: { Dind: 0.001 } }],
  objects: [
    magnet("active", { material_ref: "mat" }),
    magnet("disabled", { material_ref: "mat", physics_stack: [
      { kind: "interfacial_dmi", enabled: false },
      { kind: "demag", enabled: false },
    ] }),
    magnet("no-dmi"),
    magnet("aux", { role: "auxiliary", material_ref: "mat", physics_stack: [{ kind: "interfacial_dmi" }] }),
    magnet("antenna", { role: "antenna", material_ref: "mat", physics_stack: [{ kind: "demag" }] }),
    magnet("air", { role: "airbox", material_ref: "mat" }),
  ],
});
assert.equal(kind(mixed.physicsInteractions, "interfacial_dmi").enabledCount, 1);
assert.equal(kind(mixed.physicsInteractions, "interfacial_dmi").objectCount, 2);
assert.equal(kind(mixed.physicsInteractions, "exchange").enabledCount, 0);
assert.equal(kind(mixed.physicsInteractions, "exchange").objectCount, 3);
assert.equal(kind(mixed.physicsInteractions, "demag").enabledCount, 2);
assert.equal(kind(mixed.physicsInteractions, "demag").objectCount, 3);
assert.deepEqual(mixed.objects.filter((object) => ["aux", "antenna"].includes(object.id)).map((object) => object.physicsInteractions), [[], []]);
assert.ok(!mixed.objects.some((object) => object.id === "air"));
// Invalid duplicate IDs are rejected by authoring; reporting must still count
// the same snapshot entries that the object tree receives rather than hide one.
const duplicateIds = inspect({ objects: [
  magnet("duplicate", { physics_stack: [{ kind: "interfacial_dmi", enabled: true }] }),
  magnet("duplicate", { physics_stack: [{ kind: "interfacial_dmi", enabled: false }] }),
] });
assert.equal(duplicateIds.objects.length, 2);
assert.equal(kind(duplicateIds.physicsInteractions, "interfacial_dmi").objectCount, 2);
assert.equal(kind(duplicateIds.physicsInteractions, "interfacial_dmi").enabledCount, 1);

console.log(JSON.stringify({ check: "explorer-physics-reporting", cases, passed: true, emitted_code: false, solver_execution: false }));
