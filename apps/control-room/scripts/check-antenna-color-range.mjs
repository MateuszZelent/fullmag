import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = stripTypeScriptTypes(readFileSync(new URL("../src/kernel/visualization/antennaColorRange.ts", import.meta.url), "utf8"));
const { parseAntennaColorRange: parse, antennaColorCoordinate: coordinate, resolveAntennaColorRange: resolve, antennaSurfaceColorRange: surface } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
let checks = 0;
for (const [low, high] of [["", "1"], ["0", " "], ["NaN", "1"], ["0", "Infinity"], ["2", "1"], ["1", "1"]]) { assert.throws(() => parse(low, high)); checks++; }
const data = { minimum: -2, maximum: 2 }, manual = parse("-1e0", "1e0");
assert.equal(resolve(data), data); assert.equal(resolve(data, manual), manual); assert.deepEqual(data, { minimum: -2, maximum: 2 }); checks++;
assert.deepEqual([-2, -1, 0, 1, 2].map(value => coordinate(value, manual)), [0, 0, 0.5, 1, 1]); checks++;
assert.equal(coordinate(0, { minimum: -1e308, maximum: 1e308 }), 0.5); assert.equal(coordinate(7, { minimum: 7, maximum: 7 }), 0.5); checks++;
assert.deepEqual(surface(manual, 2), { minimum: -0.5, maximum: 0.5 }); checks++;
for (const range of [{ minimum: 0, maximum: 1e300 }, { minimum: 1, maximum: 1 + Number.EPSILON }]) { assert.throws(() => surface(range, 1), /precision/); checks++; }
console.log(JSON.stringify({ passed: true, checks, qualification: "interpreted production helper; no compiled tests" }));
