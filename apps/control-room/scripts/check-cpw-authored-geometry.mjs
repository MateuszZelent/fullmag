import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Interpret the production model directly: no test bundle, renderer or solver.
const path = fileURLToPath(new URL("../src/shared/domain/geometry/authoredMicrostripGeometry.ts", import.meta.url));
const geometryModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { identifier: path });
await geometryModule.link(() => { throw new Error("The geometry model must remain resource-independent."); });
await geometryModule.evaluate();
const build = geometryModule.namespace.buildAuthoredCpwGeometry;
const close = (actual, expected, tolerance = 1e-14) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const stations = [0, 0.4, 0.48, 0.52, 0.6, 1].map((s, index) => ({
  s, signal_width_m: [1, 1, 0.2, 0.2, 1, 1][index] * 1e-6,
  left_gap_m: 0.5e-6, right_gap_m: 0.5e-6,
  left_ground_width_m: 1e-6, right_ground_width_m: 1e-6,
}));
const params = {
  length_m: 10e-6, thickness_m: 100e-9, stations,
  conductors: [{ id: "left-custom", kind: "ground_left" }, { id: "right-custom", kind: "ground_right" }, { id: "trace-custom", kind: "signal" }],
};
const original = JSON.stringify(params);
const preview = build(params, {});
const point = (geometry, index) => geometry.positions.slice(index * 3, index * 3 + 3);
function volumes(geometry) {
  return Array.from(geometry.parts, (part, partIndex) => {
    const edges = new Map();
    let volume = 0;
    for (let offset = part.indexStart; offset < part.indexStart + part.indexCount; offset += 3) {
      const triangle = geometry.indices.slice(offset, offset + 3);
      assert.ok(triangle.every((index) => index >= partIndex * 24 && index < (partIndex + 1) * 24), "triangle crosses conductors");
      const [a, b, c] = triangle.map((index) => point(geometry, index));
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      for (let side = 0; side < 3; side++) {
        const from = triangle[side], to = triangle[(side + 1) % 3];
        const key = [from, to].sort((left, right) => left - right).join(":");
        const edge = edges.get(key) ?? { count: 0, orientation: 0 };
        edge.count++;
        edge.orientation += from < to ? 1 : -1;
        edges.set(key, edge);
      }
    }
    assert.ok([...edges.values()].every((edge) => edge.count === 2 && edge.orientation === 0), "surface is not closed and consistently oriented");
    return volume;
  });
}
check("six-station constriction has three separate closed outward conductor lofts", () => {
  assert.equal(preview.positions.length, 216);
  assert.equal(preview.indices.length, 396);
  assert.deepEqual(Array.from(preview.parts, (part) => part.id), ["trace-custom", "left-custom", "right-custom"]);
  const expected = [0.904e-18, 1e-18, 1e-18];
  volumes(preview).forEach((volume, index) => close(volume, expected[index], expected[index] * 1e-10));
  close(volumes(preview).reduce((sum, volume) => sum + volume, 0), 2.904e-18, 2.904e-28);
  close(point(preview, 8)[1], -0.1e-6);
  assert.equal(JSON.stringify(params), original);
});
check("asymmetric independent gaps and ground widths remain empty between metals", () => {
  const asymmetric = build({ ...params, stations: stations.map((station, index) => ({ ...station,
    left_gap_m: (0.2 + index * 0.1) * 1e-6, right_gap_m: (0.7 - index * 0.1) * 1e-6,
    left_ground_width_m: (1 + index * 0.2) * 1e-6, right_ground_width_m: (2 - index * 0.2) * 1e-6,
  })) }, {});
  for (let index = 0; index < stations.length; index++) {
    const signalMin = point(asymmetric, index * 4)[1];
    const signalMax = point(asymmetric, index * 4 + 1)[1];
    const leftMin = point(asymmetric, 24 + index * 4)[1];
    const leftMax = point(asymmetric, 24 + index * 4 + 1)[1];
    const rightMin = point(asymmetric, 48 + index * 4)[1];
    const rightMax = point(asymmetric, 48 + index * 4 + 1)[1];
    close(signalMin - leftMax, (0.2 + index * 0.1) * 1e-6);
    close(rightMin - signalMax, (0.7 - index * 0.1) * 1e-6);
    close(leftMax - leftMin, (1 + index * 0.2) * 1e-6);
    close(rightMax - rightMin, (2 - index * 0.2) * 1e-6);
  }
  for (let axis = 0; axis < 3; axis++) {
    const values = asymmetric.positions.filter((_value, index) => index % 3 === axis);
    close(asymmetric.boundsMin[axis], Math.min(...values));
    close(asymmetric.boundsMax[axis], Math.max(...values));
  }
});
check("inner rotation and separate owner transform preserve every vertex and volume", () => {
  const transformed = build({ ...params, transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translation_m: [3e-6, -2e-6, 5e-6] } }, { scale: [2, 3, 4], rotation_quat: [0, 0, 1, 0], translation: [10e-6, 20e-6, 30e-6] });
  for (let index = 0; index < preview.positions.length / 3; index++) {
    const [x, y, z] = point(preview, index);
    const expected = [-2 * (-y + 3e-6) + 10e-6, -3 * (x - 2e-6) + 20e-6, 4 * (z + 5e-6) + 30e-6];
    point(transformed, index).forEach((value, axis) => close(value, expected[axis]));
  }
  volumes(transformed).forEach((volume, index) => close(volume, [0.904e-18, 1e-18, 1e-18][index] * 24, 3e-27));
});
check("all five station dimensions reject zero, missing and nonfinite values", () => {
  for (const key of ["signal_width_m", "left_gap_m", "right_gap_m", "left_ground_width_m", "right_ground_width_m"]) {
    for (const invalid of [0, -1, NaN, Infinity, undefined]) {
      assert.throws(() => build({ ...params, stations: stations.map((station, index) => index === 2 ? { ...station, [key]: invalid } : station) }, {}), new RegExp(key));
    }
  }
});
check("invalid station order, conductor ownership and nonrigid transforms fail explicitly", () => {
  for (const invalid of [[], stations.slice(1), [...stations].reverse(), [stations[0], stations[0], stations.at(-1)]]) assert.throws(() => build({ ...params, stations: invalid }, {}));
  for (const invalid of [[], params.conductors.slice(0, 2), params.conductors.map((part) => ({ ...part, id: "duplicate" })), params.conductors.map((part) => ({ ...part, kind: "signal" }))]) assert.throws(() => build({ ...params, conductors: invalid }, {}));
  assert.throws(() => build({ ...params, transform: { rotation_matrix: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]] } }, {}), /right-handed/);
  assert.throws(() => build(params, { pivot: [1, 0, 0] }), /pivot/);
  assert.throws(() => build(params, { rotation_quat: [0, 0, 0, 2] }), /unit quaternion/);
  assert.throws(() => build(params, { scale: [0, 1, 1] }), /positive/);
  assert.throws(() => build({ ...params, length_m: 1e40 }, {}), /floating-point/);
  assert.throws(() => build({ ...params, stations: Array.from({ length: 8193 }, (_value, index) => ({ ...stations[0], s: index / 8192 })) }, {}), /8192/);
});
console.log(`CPW authored geometry: ${checks} interpreted checks PASS; not connected to viewport yet, no browser/runtime/solver qualification.`);
