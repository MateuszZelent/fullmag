import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as three from "three";
import * as react from "react";

// Actual TypeScript models and actual Three.js geometry; no test-target compilation or renderer.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console });
const modules = new Map();
for (const [name, namespace] of [["three", three], ["react", react]]) {
  modules.set(name, new vm.SyntheticModule(Object.keys(namespace), function () {
    for (const [key, value] of Object.entries(namespace)) this.setExport(key, value);
  }, { context }));
}
function source(path) {
  if (!modules.has(path)) modules.set(path, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { context, identifier: path }));
  return modules.get(path);
}
function link(specifier, owner) {
  if (modules.has(specifier)) return modules.get(specifier);
  const base = specifier.startsWith("@/") ? resolve(root, "src", specifier.slice(2)) : resolve(dirname(owner.identifier), specifier);
  const path = [base, `${base}.ts`].find((candidate) => existsSync(candidate));
  assert.ok(path, `Unsupported source dependency: ${specifier}`);
  return source(path);
}
const entry = new vm.SourceTextModule(`
  export * from "@/shared/domain/geometry/authoredMicrostripGeometry";
  export * from "@/modules/viewport-3d/viewport3dPrimitiveModel";
  export * from "@/modules/viewport-3d/layers/PrimitiveObjectLayerModel";
  export * from "@/modules/viewport-3d/hooks/useViewport3DColors";
  export * from "@/modules/viewport-3d/layers/viewport3DLayerSettings";
`, { context, identifier: resolve(root, "src", "regression.ts") });
await entry.link(link);
await entry.evaluate();
const { buildAuthoredMicrostripGeometry: build, buildViewport3DPrimitiveRenderModel: model, createPrimitiveObjectGeometry: geometry, primitiveObjectSurfaceColor: color, readViewport3DColorsFromStyles: readColors } = entry.namespace;
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const params = {
  length_m: 1, thickness_m: 0.2, conductivity_s_per_m: 5.8e7,
  return_width_m: 5, return_offset_m: 0.4,
  stations: [{ s: 0, signal_width_m: 2 }, { s: 0.5, signal_width_m: 1 }, { s: 1, signal_width_m: 3 }],
  conductors: [{ id: "signal-custom", kind: "signal" }, { id: "return-custom", kind: "return" }],
};
const original = JSON.stringify(params);
const preview = build(params, {});
check("separate signal/return and canonical insulating clearance", () => {
  assert.equal(preview.positions.length, 24 * 3);
  assert.equal(preview.indices.length, 120);
  assert.deepEqual(Array.from(preview.parts, (part) => part.id), ["signal-custom", "return-custom"]);
  close(preview.positions[2], -0.1);
  close(preview.positions[4 * 3 + 1], -0.5);
  close(preview.positions[12 * 3 + 2], -0.7);
  close((-0.1) - preview.positions[(12 + 2) * 3 + 2], 0.4);
});
check("closed outward surfaces with no internal station walls or conductor bridge", () => {
  for (const part of preview.parts) {
    const edges = new Map();
    let volume = 0;
    const vertexMin = part.indexStart === 0 ? 0 : 12;
    for (let offset = part.indexStart; offset < part.indexStart + part.indexCount; offset += 3) {
      const tri = preview.indices.slice(offset, offset + 3);
      assert.ok(tri.every((index) => index >= vertexMin && index < vertexMin + 12));
      const points = tri.map((index) => preview.positions.slice(index * 3, index * 3 + 3));
      assert.ok(!points.every((point) => point[0] === 0.5), "internal station cap");
      const [a, b, c] = points;
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      for (let side = 0; side < 3; side++) {
        const key = [tri[side], tri[(side + 1) % 3]].sort((left, right) => left - right).join(":");
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    assert.ok([...edges.values()].every((count) => count === 2));
    assert.ok(volume > 0);
  }
});
check("inner rigid transform and outer scale/quaternion/translation retained", () => {
  const rotated = build({ ...params, transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translation_m: [2, 3, 4] } }, { scale: [2, 3, 4], rotation_quat: [0, 0, 1, 0], translation: [10, 20, 30] });
  [4, 11, 45.6].forEach((expected, axis) => close(rotated.positions[axis], expected));
  for (let axis = 0; axis < 3; axis++) {
    const values = rotated.positions.filter((_value, index) => index % 3 === axis);
    close(rotated.boundsMin[axis], Math.min(...values));
    close(rotated.boundsMax[axis], Math.max(...values));
  }
});
const object = { id: "immutable-antenna", name: "Not used as physics", role: "antenna", geometry: { geometry_kind: "MicrostripAntennaLayout", geometry_params: params, bounds_min: [-99, -99, -99], bounds_max: [99, 99, 99] }, transform: { translation: [0, 0, 2] }, physics_stack: [] };
const rendered = model({ revision: 7, objects: [object] }, null);
check("microstrip mesh freshness requires the current authored scene revision", () => {
  for (const sourceRevision of [6, 8, undefined, NaN]) {
    const manifest = { source_scene_revision: sourceRevision, mesh_parts: [{ object_id: object.id }] };
    assert.equal(model({ revision: 7, objects: [object] }, manifest).objects[0].meshState, "mesh-stale");
  }
  const manifest = { source_scene_revision: 7, mesh_parts: [{ object_id: object.id }] };
  assert.equal(model({ revision: 7, objects: [object] }, manifest).objects[0].meshState, "mesh-ready");
  assert.equal(model({ revision: 7, objects: [{ ...object, tags: ["mesh:dirty"] }] }, manifest).objects[0].meshState, "mesh-stale");
});
check("canonical recognized loft ignores stale bounds and preserves identity", () => {
  assert.equal(rendered.objects[0].kind, "microstrip");
  assert.equal(rendered.objects[0].objectId, object.id);
  close(rendered.objects[0].bounds.size[0], 1);
  close(rendered.objects[0].bounds.size[1], 5);
  close(rendered.objects[0].bounds.center[2], 1.7);
  assert.equal(rendered.diagnostics.length, 0);
  assert.equal(JSON.stringify(params), original);
  assert.deepEqual(object.physics_stack, []);
});
check("actual Three geometry recenters world vertices and retains conductor metadata", () => {
  const carrier = rendered.objects[0];
  const result = geometry(carrier);
  assert.ok(result instanceof three.BufferGeometry);
  const positions = result.getAttribute("position");
  for (let index = 0; index < positions.array.length; index++) close(positions.array[index] + carrier.bounds.center[index % 3], carrier.microstripPreview.positions[index], 1e-6);
  assert.equal(result.index.count, carrier.microstripPreview.indices.length);
  assert.deepEqual(Array.from(result.userData.conductorParts, (part) => part.id), ["signal-custom", "return-custom"]);
  let disposed = 0;
  result.addEventListener("dispose", () => disposed++);
  result.dispose();
  assert.equal(disposed, 1);
});
check("invalid recognized layouts never fall back to fake bounds box", () => {
  const invalid = model({ revision: 7, objects: [{ ...object, transform: { pivot: [1, 0, 0] } }] }, null);
  assert.equal(invalid.objects.length, 0);
  assert.equal(invalid.diagnostics[0].objectId, object.id);
  assert.match(invalid.diagnostics[0].message, /pivot/);
  for (const patch of [{ thickness_m: 0 }, { return_offset_m: -1 }, { conductors: [{ id: "duplicate", kind: "signal" }, { id: "duplicate", kind: "return" }] }, { conductors: [{ id: "a", kind: "signal" }, { id: "b", kind: "signal" }] }, { stations: [{ s: 1, signal_width_m: 1 }, { s: 0, signal_width_m: 1 }] }, { transform: { rotation_matrix: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]] } }]) assert.throws(() => build({ ...params, ...patch }, {}));
  for (const transform of [{ scale: [0, 1, 1] }, { rotation_quat: [0, 0, 0, 0] }, { translation: [NaN, 0, 0] }]) assert.throws(() => build(params, transform));
});
check("role-only gold presentation and literal override precedence", () => {
  const settings = { surfaceColorSource: "orientation", primitiveMonoColor: "var(--fm-surface-magnetic)", shaderMonoColor: "var(--fm-surface-magnetic)" };
  const colors = { mesh: "gray", antenna: "gold" };
  assert.equal(color({ role: "antenna" }, settings, colors), "gold");
  assert.equal(color({ role: "magnet" }, settings, colors), "gray");
  assert.equal(color({ role: "antenna" }, { ...settings, primitiveMonoColor: "#112233" }, colors), "#112233");
  assert.equal(color({ role: "antenna" }, { ...settings, surfaceColorSource: "solid", shaderMonoColor: "#445566" }, colors), "#445566");
});
check("central antenna token consumed without altering scalar buffers", () => {
  const tokens = { "--fm-accent": "blue", "--fm-surface-antenna": "gold", "--fm-bg-viewport": "black", "--fm-syntax-string": "green", "--fm-surface-3": "gray", "--fm-text-muted": "silver" };
  assert.equal(readColors({ getPropertyValue: (name) => tokens[name] ?? "" }).antenna, "gold");
});
check("realized mesh uses exact authored owner and preserves scientific color precedence", () => {
  const { resolveMeshPartPresentationColor: presentation, resolveMeshPartSurfaceMaterialColor: surface } = entry.namespace;
  const objects = [{ objectId: "source-1", role: "antenna" }, { objectId: "waveguide", role: "magnet", label: "antenna" }];
  const colors = { mesh: "gray", antenna: "gold" };
  assert.equal(presentation("source-1", objects, colors), "gold");
  for (const id of ["source-1_geom", "waveguide", "missing", null, undefined]) assert.equal(presentation(id, objects, colors), "gray");
  assert.equal(presentation("source-1", [], colors), "gray");
  assert.equal(presentation("source-1", objects, { mesh: "gray" }), "gray");
  const settings = { surfaceColorSource: "orientation", shaderColorMode: "orientation", shaderMonoColor: "var(--fm-surface-magnetic)" };
  const fallback = presentation("source-1", objects, colors);
  assert.equal(surface(settings, fallback, null, false), "gold");
  assert.equal(surface({ ...settings, surfaceColorSource: "solid", shaderMonoColor: "#112233" }, fallback, "red", false), "#112233");
  assert.equal(surface(settings, fallback, "red", false), "red");
  assert.equal(surface({ ...settings, shaderColorMode: "monochrome", shaderMonoColor: "#aabbcc" }, fallback, null, false), "#aabbcc");
  assert.equal(surface(settings, fallback, null, true), 0xffffff);
  assert.equal(presentation("source-1", [{ objectId: "source-1", role: "magnet" }], colors), "gray");
  assert.equal(presentation("source-1", objects, { ...colors, antenna: "yellow" }), "yellow");
});
check("canonical nanometre default agrees with source-owned signal/return bounds", () => {
  const nano = { length_m: 1e-6, thickness_m: 10e-9, conductivity_s_per_m: 5.8e7, return_width_m: 500e-9, return_offset_m: 30e-9, stations: [{ s: 0, signal_width_m: 50e-9 }, { s: 0.5, signal_width_m: 600e-9 }, { s: 1, signal_width_m: 50e-9 }], transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translation_m: [0, -0.5e-6, 0] } };
  const shaped = build(nano, {});
  [-300e-9, -0.5e-6, -45e-9].forEach((value, axis) => close(shaped.boundsMin[axis], value, 1e-18));
  [300e-9, 0.5e-6, 5e-9].forEach((value, axis) => close(shaped.boundsMax[axis], value, 1e-18));
  const carrier = model({ revision: 8, objects: [{ ...object, geometry: { geometry_kind: "MicrostripAntennaLayout", geometry_params: nano }, transform: {} }] }, null).objects[0];
  const buffer = geometry(carrier);
  const positions = buffer.getAttribute("position").array;
  for (let index = 0; index < positions.length; index++) close(positions[index] + carrier.bounds.center[index % 3], shaped.positions[index], 3e-14);
  buffer.dispose();
});
check("preview budgets and unrepresentable coordinates fail with explicit reasons", () => {
  assert.throws(() => build({ ...params, stations: Array.from({ length: 8193 }, (_value, index) => ({ s: index / 8192, signal_width_m: 1 })) }, {}), /at most 8192/);
  assert.throws(() => build({ ...params, length_m: 1e40 }, {}), /floating-point coordinate range/);
});
console.log(`Microstrip viewport interpreted model: ${checks} checks passed; no WebGL/runtime/solver qualification.`);
const liveIndex = process.argv.indexOf("--scene-url");
if (liveIndex !== -1) {
  const url = new URL(process.argv[liveIndex + 1]);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Live diagnostic must use the explicitly scoped local API");
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  assert.ok(response.ok, `Live scene GET failed: ${response.status}`);
  const scene = await response.json();
  const liveModel = model(scene, null);
  for (const authored of scene.objects.filter((candidate) => candidate.geometry?.geometry_kind === "MicrostripAntennaLayout")) {
    const carrier = liveModel.objects.find((candidate) => candidate.objectId === authored.id);
    assert.ok(carrier, JSON.stringify(liveModel.diagnostics));
    assert.equal(carrier.kind, "microstrip");
    console.log(`LIVE scene=${scene.revision} object=${carrier.objectId} kind=${carrier.kind} size_m=${JSON.stringify(carrier.bounds.size)} parts=${JSON.stringify(carrier.microstripPreview.parts.map((part) => part.id))}`);
  }
}
