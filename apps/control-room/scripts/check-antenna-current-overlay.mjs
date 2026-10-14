import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret actual production adapters; this does not build unit-test targets.
const context = vm.createContext();
const loadModule = (path) => new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8")), { context });
const base = loadModule("../src/modules/viewport-3d/model/antennaFieldOverlayModel.ts");
await base.link(() => { throw new Error("Unexpected base adapter dependency"); });
await base.evaluate();
const current = loadModule("../src/modules/viewport-3d/model/antennaCurrentOverlayModel.ts");
await current.link((specifier) => {
  assert.equal(specifier, "./antennaFieldOverlayModel");
  return base;
});
await current.evaluate();
const { buildAntennaCurrentOverlayModel: build, projectAntennaCurrentOverlayModel: project, antennaCurrentTraceShape: shape } = current.namespace;
const f64 = (values) => {
  const result = new ArrayBuffer(values.length * 8), view = new DataView(result);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true)); return result;
};
const u32 = (values) => {
  const result = new ArrayBuffer(values.length * 4), view = new DataView(result);
  values.forEach((value, index) => view.setUint32(index * 4, value, true)); return result;
};
const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];
const indices = [0, 1, 2, 3, 0, 2, 1, 4];
const traces = indices.flatMap((index) => points[index]);
const vectors = indices.flatMap((index, local) => points[index].map((value, axis) =>
  value * 2 - 1 + (local >= 4 && axis === 0 ? 4 : 0)));
const centers = f64([0.25, 0.25, 0.25, 0.25, 0.25, -0.25]);
const values = f64([-0.5, -0.5, -0.5, 3.5, -0.5, -1.5]);
const tracePositions = f64(traces), traceValues = f64(vectors), positions = f64(points.flat()), topology = u32(indices);
const intent = { kind: "inspection", quantity: "current_density", component: "magnitude", vectors: true, points: true, surface: true, palette: "viridis" };
const model = build(centers, values, tracePositions, traceValues, positions, topology, 2, intent);
let checks = 0;
const check = (actual, expected) => { assert.equal(actual, expected); checks++; };
check(model.count, 2);
check(model.surfacePositions.length, 24);
check(model.surfaceTriangles.length, 18);
check(model.surfaceEdges.length, 18);
check(model.vectorSegments.length, 12);
check(model.minimum, 0);
check(model.surfaceVectorValues[0] < 0, true);
check(model.surfaceVectorValues[12] > 0, true);
check(model.wirePositions.length, 15);
check(model.scalarValues[0], Math.hypot(-0.5, -0.5, -0.5));
for (const index of model.surfaceTriangles) check(index >= 0 && index < 8, true);
const x = build(centers, values, tracePositions, traceValues, positions, topology, 2, { ...intent, component: "x" });
check(x.minimum, -1); check(x.maximum, 5);
check(x.vectorSegments[3] - x.vectorSegments[0] < 0, true);
check(x.vectorSegments[9] - x.vectorSegments[6] > 0, true);
for (const component of ["x", "y", "z", "magnitude"]) {
  const projected = project(model, values, traceValues, { ...intent, component, palette: "coolwarm", vectors: false });
  const rebuilt = build(centers, values, tracePositions, traceValues, positions, topology, 2, { ...intent, component });
  for (const key of ["positions", "surfacePositions", "surfaceVectorValues", "surfaceTriangles", "surfaceEdges", "wirePositions", "vectorSegments"]) check(projected[key] === model[key], true);
  check(projected.minimum, rebuilt.minimum); check(projected.maximum, rebuilt.maximum);
  check(projected.scalarValues[0], rebuilt.scalarValues[0]); check(projected.scalarValues[1], rebuilt.scalarValues[1]);
}
const one = build(f64([0.25, 0.25, 0.25]), f64([1, 2, 3]), f64(traces.slice(0, 12)), f64(vectors.slice(0, 12)), f64(points.slice(0, 4).flat()), u32(indices.slice(0, 4)), 1, intent);
check(one.vectorSegments.length, 6);
check(one.vectorSegments[3] > one.vectorSegments[0], true);
check(one.scalarValues[0], Math.hypot(1, 2, 3)); // Retain the native center, do not average traces.
const descriptor = (payload, layout, unit, scalar_type = "float64_le") => ({
  value_count: payload.byteLength / (scalar_type === "uint32_le" ? 4 : 8), byte_count: payload.byteLength,
  scalar_type, layout, unit, sha256: "a".repeat(64),
});
const descriptors = [descriptor(centers, "cell_xyz_interleaved", "m"), descriptor(values, "cell_vector_xyz_interleaved", "A/m^2"),
  descriptor(tracePositions, "cell_local_vertex_xyz_interleaved", "m"), descriptor(traceValues, "cell_local_vertex_vector_xyz_interleaved", "A/m^2"),
  descriptor(positions, "node_xyz_interleaved", "m"), descriptor(topology, "tet4_connectivity", "1", "uint32_le")];
check(shape(...descriptors, intent), 2);
const rejects = (run) => { assert.throws(run); checks++; };
for (const index of [2, 3]) {
  const wrong = structuredClone(descriptors); wrong[index].unit = "A/m";
  rejects(() => shape(...wrong, intent));
}
rejects(() => shape(...descriptors, { ...intent, kind: "basis" }));
rejects(() => shape(...descriptors, { ...intent, quantity: "device_potential" }));
const mismatch = traces.slice(); mismatch[0] = 0.125;
rejects(() => build(centers, values, f64(mismatch), traceValues, positions, topology, 2, intent));
const nonfinite = vectors.slice(); nonfinite[0] = NaN;
rejects(() => build(centers, values, tracePositions, f64(nonfinite), positions, topology, 2, intent));
rejects(() => build(centers, values, tracePositions.slice(0, -8), traceValues, positions, topology, 2, intent));
rejects(() => build(centers, values, tracePositions, traceValues, positions, u32([0, 1, 2, 99, 0, 2, 1, 4]), 2, intent));
const materialSource = readFileSync(new URL("../src/modules/viewport-3d/layers/antennaCurrentSurfaceMaterial.ts", import.meta.url), "utf8");
check(materialSource.includes("length(vAntennaCurrent)"), true);
check(materialSource.includes("vAntennaCurrent = fmAntennaCurrentVector"), true);
// Source guards above are not shader execution; browser smoke is separate.
console.log(`Antenna current overlay: ${checks}/${checks} PASS (interpreted adapters; no native physics or GPU shader qualification).`);
