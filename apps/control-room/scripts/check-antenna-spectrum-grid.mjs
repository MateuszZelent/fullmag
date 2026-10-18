import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(new URL("../src/modules/inspector/panels/antenna/AntennaSourceSpectrumPayloadView.tsx", import.meta.url), "utf8");
const extract = (name, end) => source.slice(source.indexOf(`function ${name}(`), source.indexOf(end, source.indexOf(`function ${name}(`)));
const code = `const MAX_AXIS_CELLS = 64;
${extract("spectrumPowerExtrema", "function SpectrumPowerScale(")}
${extract("spectrumGridTarget", "/** Selection stays local")}
${extract("heatmapCells", "function formatScientific(")}
export { spectrumPowerExtrema, spectrumGridTarget, heatmapCells };`;
const { spectrumPowerExtrema, spectrumGridTarget, heatmapCells } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code)).toString("base64")}`);
const u = Array.from({ length: 65 }, (_, i) => i - 32), v = Array.from({ length: 67 }, (_, i) => i - 33);
const power = Array.from({ length: u.length * v.length }, (_, i) => (i + 1) ** 2);
const before = power.slice(), cells = heatmapCells(u, v, power);
assert.equal(cells.length, 4096); assert.equal(cells.at(-1).power, 4355 ** 2);
assert.deepEqual([cells.at(-1).kUIndex, cells.at(-1).kVIndex], [64, 66]);
assert.equal(cells.at(-1).normalizedPower, 1); assert.ok(cells.every(cell => cell.normalizedPower >= 0 && cell.normalizedPower <= 1));
assert.deepEqual(power, before);
assert.deepEqual(spectrumPowerExtrema(power), { minimum: 1, maximum: 4355 ** 2, peakIndex: 4354 });
assert.equal(spectrumGridTarget("ArrowRight", 63, 64, 4096), 63);
assert.equal(spectrumGridTarget("ArrowLeft", 64, 64, 4096), 64);
assert.equal(spectrumGridTarget("ArrowDown", 4095, 64, 4096), 4095);
assert.equal(spectrumGridTarget("Home", 129, 64, 4096), 128);
assert.equal(spectrumGridTarget("End", 129, 64, 4096), 191);
assert.equal(spectrumGridTarget("End", 0, 64, 4096, true), 4095);
assert.equal(spectrumGridTarget("Home", 4095, 64, 4096, true), 0);
assert.equal(spectrumGridTarget("Tab", 0, 64, 4096), null);
assert.deepEqual(heatmapCells([0], [0], [9]), [{ kUIndex: 0, kVIndex: 0, power: 9, normalizedPower: 0 }]);
assert.deepEqual(spectrumPowerExtrema([9, 9]), { minimum: 9, maximum: 9, peakIndex: 0 });
assert.deepEqual(spectrumPowerExtrema([-32, 32, -1]), { minimum: -32, maximum: 32, peakIndex: 1 });
console.log("PASS actual production spectrum helpers: bounded 65x67 pooling, exact peak and coordinates, immutable data, normalized range, constant power, signed axes and keyboard boundaries; no compiled tests");
