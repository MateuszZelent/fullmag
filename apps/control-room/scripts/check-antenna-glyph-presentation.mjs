import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
const source = stripTypeScriptTypes(readFileSync(new URL("../src/modules/viewport-3d/model/antennaGlyphPresentation.ts", import.meta.url), "utf8"));
const { scaleAntennaGlyphSegments: scale, encodeAntennaGlyphSegments: encode } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const segments = Float32Array.from([1, 2, 3, 2, 4, 6, 4, 5, 6, 2, 3, 4, 1, 1, 1, 1, 1, 1]);
assert.strictEqual(scale(segments, 1), segments); assert.equal(scale(null, 4), null);
assert.deepEqual(Array.from(scale(segments, 4)), [1, 2, 3, 5, 10, 15, 4, 5, 6, -4, -3, -2, 1, 1, 1, 1, 1, 1]);
assert.deepEqual(Array.from(segments), [1, 2, 3, 2, 4, 6, 4, 5, 6, 2, 3, 4, 1, 1, 1, 1, 1, 1]);
for (const value of [0, 3, -1, NaN, Infinity]) assert.throws(() => scale(segments, value), /Unsupported/);
assert.throws(() => scale(Float32Array.from([-3e38, 0, 0, 3e38, 0, 0]), 4), /represented/);
console.log("PASS anchors, signed relative amplitudes, zeros, immutable source, identity reuse, invalid multiplier and Float32 overflow; interpreted production helper only.");

// Interpret the actual shared decoder and its production dependencies; no mocked transform path.
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  let source = stripTypeScriptTypes(readFileSync(file, "utf8"));
  source = source.replace(/from\s+["'](\.[^"']+)["']/g, (whole, specifier) => {
    const target = resolve(dirname(file), specifier);
    return `from "${load(existsSync(target + ".ts") ? target + ".ts" : target)}"`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  modules.set(file, url); return url;
}
const { buildVectorGlyphTransforms } = await import(load(fileURLToPath(new URL("../src/modules/viewport-3d/layers/vectorGlyphGeometry.ts", import.meta.url))));
for (const count of [1, 6, 7, 8, 14, 49]) {
  const input = new Float32Array(count * 6);
  for (let index = 0; index < count; index++) input.set([index, 0, 0, index, index + 1, 0], index * 6);
  const before = input.slice(), packed = encode(input, count), decoded = buildVectorGlyphTransforms(packed);
  assert.equal(decoded.count, count);
  assert.deepEqual(input, before);
  for (let index = 0; index < count; index++) {
    assert.deepEqual(Array.from(packed.slice(index * 7, index * 7 + 6)), Array.from(before.slice(index * 6, index * 6 + 6)));
    assert.ok(Math.abs(packed[index * 7 + 6] - (index + 1) / count) < 1e-7);
    assert.deepEqual(Array.from(decoded.directions.slice(index * 3, index * 3 + 3)), [0, 1, 0]);
    assert.equal(decoded.shaftCenters[index * 3], index);
  }
}
assert.equal(encode(null, 0), null);
assert.throws(() => encode(segments, 7), /cardinality/);
assert.throws(() => encode(Float32Array.from([0, 0, 0, NaN, 1, 0]), 1), /Non-finite/);
console.log("PASS real shared decoder preserves all1/6/7/8/14/49 samples, positions, directions and relative amplitudes in explicit seven-channel antenna segments.");
