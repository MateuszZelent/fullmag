// Execute the production TypeScript model directly with Node type stripping.
// No native build, Vitest compilation, frontend bundle or browser is involved.
import assert from "node:assert/strict";
import { frequencySpectrumRenderModel } from "../src/shared/analysis-charts/frequencyRenderModels.ts";

const units = [["Hz", 1], ["kHz", 1e3], ["MHz", 1e6], ["GHz", 1e9]];
const curves = units.map(([unit, scale]) => {
  const model = frequencySpectrumRenderModel([
    { dampingRateHz: 1e8, frequencyValue: 10e9 / scale, rowIndex: 7 },
  ], unit);
  assert.equal(model.status, "ready");
  const curve = model.series.find((series) => series.id === "spectral-envelope");
  assert.ok(curve, "A damped mode must publish the spectral-envelope series.");
  assert.equal(curve.points.length, 501);
  assert.equal(curve.label, "Illustrative modal envelope");
  const modes = model.series.find((series) => series.id === "modes");
  assert.ok(modes, "A damped mode must retain the modes series.");
  assert.deepEqual(modes.points,
    [{ rowIndex: 7, x: 10e9 / scale, y: 1 }]);
  return curve.points.map((point) => ({ xHz: point.x * scale, y: point.y }));
});
for (const curve of curves.slice(1)) {
  curve.forEach((point, i) => {
    assert.ok(Math.abs(point.y - curves[0][i].y) < 1e-12);
    assert.ok(Math.abs(point.xHz - curves[0][i].xHz) < 1e-4);
  });
}
// Normalization cancels in a ratio; a 100 MHz HWHM must not become 50 MHz.
const [a, b] = [curves[0][30], curves[0][80]];
const expected = ((b.xHz - 10e9) ** 2 + 1e16) / ((a.xHz - 10e9) ** 2 + 1e16);
assert.ok(Math.abs(a.y / b.y - expected) < 1e-12);
for (const unit of ["rad/s", "unknown", "toString"]) {
  const model = frequencySpectrumRenderModel([
    { dampingRateHz: 1e8, frequencyValue: 10, rowIndex: 0 },
  ], unit);
  assert.equal(model.status, "unsupported");
  assert.match(model.statusMessage, /Unsupported frequency unit/);
  assert.deepEqual(model.series, []);
}
const undamped = frequencySpectrumRenderModel([{ frequencyValue: 10, rowIndex: 3 }], "GHz");
assert.equal(undamped.series.length, 1);
assert.equal(undamped.series[0].id, "modes");
assert.equal(frequencySpectrumRenderModel([], "Hz").status, "empty");
console.log(JSON.stringify({ status: "PASS", scope: "production TypeScript model executed directly", checks: ["unit invariance", "HWHM ratio", "sample identity", "unknown units", "undamped and empty"], browser: "NOT VERIFIED" }));
