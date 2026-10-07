import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Interpret the actual pure TypeScript sources; no test-target compilation, renderer, or solver.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console });
const allowedSources = new Set([
  "src/shared/domain/geometry/antennaPlacement.ts",
  "src/shared/domain/geometry/authoredMicrostripGeometry.ts",
  "src/modules/inspector/panels/antenna/AntennaPlacementModel.ts",
].map((path) => resolve(root, path)));
const modules = new Map();
function source(path) {
  assert.ok(allowedSources.has(path), `Unexpected placement model dependency: ${path}`);
  if (!modules.has(path)) modules.set(path, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { context, identifier: path }));
  return modules.get(path);
}
async function load(relativePath) {
  const sourceModule = source(resolve(root, relativePath));
  if (sourceModule.status === "unlinked") await sourceModule.link((specifier) => {
    assert.ok(specifier.startsWith("@/shared/domain/geometry/"), `Unexpected runtime import: ${specifier}`);
    return source(resolve(root, "src", `${specifier.slice(2)}.ts`));
  });
  if (sourceModule.status !== "evaluated") await sourceModule.evaluate();
  return sourceModule.namespace;
}
const { calculateAntennaPlacement: place } = await load("src/shared/domain/geometry/antennaPlacement.ts");
const { buildAuthoredMicrostripGeometry: build } = await load("src/shared/domain/geometry/authoredMicrostripGeometry.ts");
const { resolveAntennaPlacement: resolvePlacement, antennaPlacementTargets: targets } = await load("src/modules/inspector/panels/antenna/AntennaPlacementModel.ts");
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const close = (actual, expected, tolerance = 1e-18) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const bounds = (geometry) => ({ min: geometry.boundsMin, max: geometry.boundsMax });
const target = { min: [-2e-6, -2e-6, -20e-9], max: [2e-6, 2e-6, 20e-9] };
const params = {
  length_m: 1e-6, thickness_m: 10e-9, return_width_m: 500e-9, return_offset_m: 30e-9,
  stations: [{ s: 0, signal_width_m: 200e-9 }, { s: 0.5, signal_width_m: 50e-9 }, { s: 1, signal_width_m: 200e-9 }],
  conductors: [{ id: "immutable-signal", kind: "signal" }, { id: "immutable-return", kind: "return" }],
};
const transform = { translation: [300e-9, -500e-9, 90e-9], scale: [2, 3, 4], rotation_quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };
const original = JSON.stringify({ params, transform, target });
for (const side of ["above", "below"]) {
  check(`${side}: rotated/scaled whole assembly with nonzero original translation`, () => {
    const before = build(params, transform);
    const result = place(bounds(before), target, transform.translation, side, 25e-9);
    const after = build(params, { ...transform, translation: Array.from(result.translation) });
    close(side === "above" ? after.boundsMin[2] - target.max[2] : target.min[2] - after.boundsMax[2], 25e-9);
    for (const axis of [0, 1]) {
      assert.equal(result.translation[axis], transform.translation[axis]);
      close(after.boundsMin[axis], before.boundsMin[axis]);
      close(after.boundsMax[axis], before.boundsMax[axis]);
    }
    close(result.delta[2], result.translation[2] - transform.translation[2]);
    assert.equal(JSON.stringify({ params, transform, target }), original);
    assert.deepEqual(Array.from(after.parts, (part) => part.id), ["immutable-signal", "immutable-return"]);
  });
}
check("above uses return bottom, not signal bottom or internal insulating gap", () => {
  const antenna = build(params, {});
  const result = place(bounds(antenna), target, [0, 0, 0], "above", 50e-9);
  close(result.translation[2], 115e-9);
  const after = build(params, { translation: Array.from(result.translation) });
  close(after.boundsMin[2], 70e-9);
  assert.equal(params.return_offset_m, 30e-9);
});
check("below uses entire assembly upper envelope", () => {
  const antenna = build(params, { translation: [1e-6, 2e-6, -100e-9] });
  const result = place(bounds(antenna), target, [1e-6, 2e-6, -100e-9], "below", 50e-9);
  close(result.translation[2], -75e-9);
});
check("already positioned assembly has zero delta and does not mutate frozen input", () => {
  const antenna = Object.freeze({ min: Object.freeze([0, 0, 70e-9]), max: Object.freeze([1e-6, 1e-6, 120e-9]) });
  const current = Object.freeze([4, 5, 6]);
  const result = place(antenna, target, current, "above", 50e-9);
  close(result.delta[2], 0);
  assert.deepEqual(Array.from(result.translation), [4, 5, 6]);
});
check("invalid finite/order/side/gap inputs are rejected", () => {
  const valid = { min: [0, 0, 0], max: [1, 1, 1] };
  for (const bad of [{ min: [0, 0], max: [1, 1, 1] }, { min: [0, 0, NaN], max: [1, 1, 1] }, { min: [0, 0, 0], max: [1, Infinity, 1] }, { min: [0, 0, 1], max: [1, 1, 1] }, { min: [2, 0, 0], max: [1, 1, 1] }]) {
    assert.throws(() => place(bad, valid, [0, 0, 0], "above", 1));
    assert.throws(() => place(valid, bad, [0, 0, 0], "above", 1));
  }
  for (const gap of [0, -1, NaN, Infinity, "1"]) assert.throws(() => place(valid, valid, [0, 0, 0], "above", gap));
  assert.throws(() => place(valid, valid, [0, 0, Infinity], "above", 1));
  assert.throws(() => place(valid, valid, [0, 0, 0], "left", 1));
});
check("overflow and coordinate cancellation cannot silently satisfy an impossible gap", () => {
  const valid = { min: [0, 0, 0], max: [1, 1, 1] };
  assert.throws(() => place(valid, { min: [0, 0, 1e20], max: [1, 1, 1e20 + 1e6] }, [0, 0, 0], "above", 1e-9), /not representable/);
  assert.throws(() => place(valid, valid, [0, 0, 1e30], "above", 1e-9), /not representable/);
  assert.throws(() => place(valid, { min: [0, 0, 1e308], max: [1, 1, 1.7e308] }, [0, 0, 0], "above", 1e308), /not representable/);
});
// Fixed canonical subset from read-only scene/realization GETs, revision 3, 2026-10-07.
// Endpoints verified in apiPaths.ts: model/scene and model/geometry/realizations/current.
const antennaId = "antenna-mux902jl", targetId = "waveguide-regression-mux432js";
const canonicalTransform = { pivot: [0, 0, 0], rotation_quat: [0, 0, 0, 1], scale: [1, 1, 1], translation: [0, 0, 0] };
const liveAntenna = {
  id: antennaId, name: "Microstrip antenna", role: "antenna", locked: false,
  geometry: { geometry_kind: "MicrostripAntennaLayout", geometry_params: {
    ...params, conductors: [{ id: "signal", kind: "signal" }, { id: "return", kind: "return" }],
    transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translation_m: [0, -5e-7, 0] },
    terminal_faces: { signal: { inlet: "local_u_min", outlet: "local_u_max" }, return: { inlet: "local_u_min", outlet: "local_u_max" } },
  } }, transform: canonicalTransform,
};
const liveTarget = { id: targetId, name: "Waveguide regression", role: "magnet", magnetization_ref: `mag:${targetId}:uniform`, transform: canonicalTransform, physics_stack: [{ enabled: true, kind: "exchange", params: {} }] };
const scene = { revision: 3, objects: [liveTarget, liveAntenna], antenna_port_modes: [{ id: `${antennaId}:port:common`, source_object_id: antennaId, current_transport_id: `${antennaId}:current`, branches: [{ id: "signal", signed_weight: 1 }, { id: "return", signed_weight: -1 }] }] };
const realization = { source_scene_revision: 3, status: "blocked", bodies: [{ object_id: targetId, status: "ready", bounds_min: [-5e-7, -5e-8, -5e-9], bounds_max: [5e-7, 5e-8, 5e-9] }] };
const call = (sceneValue = scene, realizationValue = realization, targetValue = targetId, side = "above") => resolvePlacement(sceneValue, realizationValue, antennaId, targetValue, side, 50e-9);
const sceneWithAntenna = (patch) => ({ ...scene, objects: [liveTarget, { ...liveAntenna, ...patch }] });
check("actual inspector model canonical revision 3 above 50 nm produces +100 nm", () => close(call().delta[2], 100e-9));
check("actual inspector model canonical revision 3 below 50 nm produces -60 nm", () => close(call(scene, realization, targetId, "below").delta[2], -60e-9));
check("actual inspector model requires current revision and exact magnetic target identity", () => {
  assert.throws(() => call(scene, { ...realization, source_scene_revision: 2 }), /revision/);
  assert.throws(() => call({ ...scene, revision: NaN }), /revision/);
  assert.throws(() => call(scene, realization, "wrong-target"), /object ID/);
  assert.throws(() => call(scene, realization, antennaId), /object ID/);
  assert.throws(() => call({ ...scene, objects: [{ ...liveTarget, magnetization_ref: undefined }, liveAntenna] }), /object ID/);
  assert.deepEqual(Array.from(targets(scene, antennaId), (object) => object.id), [targetId]);
});
check("actual inspector model rejects locked antenna and unsupported authored outer transforms", () => {
  assert.throws(() => call(sceneWithAntenna({ locked: true })), /locked/);
  for (const patch of [{ scale: [2, 1, 1] }, { rotation_quat: [0, 0, 1, 0] }]) {
    assert.throws(() => call(sceneWithAntenna({ transform: { ...canonicalTransform, ...patch } })), /round-trip/);
  }
  assert.throws(() => call(sceneWithAntenna({ transform: { ...canonicalTransform, pivot: [1, 0, 0] } })), /pivot/);
  assert.throws(() => call({ ...scene, objects: [{ ...liveTarget, transform: { ...canonicalTransform, pivot: [0, 0, 1] } }, liveAntenna] }), /pivot/);
});
check("actual inspector model never guesses unresolved or malformed target bounds", () => {
  for (const patch of [{ status: "unresolved" }, { bounds_min: [0, 0] }, { bounds_max: [1, NaN, 1] }, { bounds_min: [1, 0, 0], bounds_max: [0, 1, 1] }]) {
    assert.throws(() => call(scene, { ...realization, bodies: [{ ...realization.bodies[0], ...patch }] }));
  }
  assert.throws(() => call(scene, { ...realization, bodies: [] }), /unavailable/);
  assert.throws(() => call(scene, { ...realization, bodies: [{ ...realization.bodies[0], object_id: "different" }] }), /unavailable/);
});
check("actual inspector model unions all exact-target compound bodies including hidden geometry", () => {
  const compound = { ...realization, bodies: [...realization.bodies,
    { object_id: targetId, status: "hidden", bounds_min: [-1e-6, -1e-7, -25e-9], bounds_max: [1e-6, 1e-7, 35e-9] },
    { object_id: "unrelated-body", status: "ready", bounds_min: [-1, -1, -1], bounds_max: [1, 1, 1] },
  ] };
  close(call(scene, compound).delta[2], 130e-9);
  close(call(scene, compound, targetId, "below").delta[2], -80e-9);
});
check("actual inspector model preserves object, conductor, port and physics references without mutation", () => {
  const before = JSON.stringify({ scene, realization });
  const objectsRef = scene.objects, portsRef = scene.antenna_port_modes, physicsRef = liveTarget.physics_stack, geometryRef = liveAntenna.geometry;
  call();
  call(scene, realization, targetId, "below");
  assert.equal(JSON.stringify({ scene, realization }), before);
  assert.equal(scene.objects, objectsRef);
  assert.equal(scene.antenna_port_modes, portsRef);
  assert.equal(liveTarget.physics_stack, physicsRef);
  assert.equal(liveAntenna.geometry, geometryRef);
  assert.equal(liveAntenna.id, antennaId);
  assert.equal(scene.antenna_port_modes[0].source_object_id, antennaId);
});
console.log(`Antenna placement interpreted model: ${checks} checks passed; no UI/transaction/WebGL qualification.`);
