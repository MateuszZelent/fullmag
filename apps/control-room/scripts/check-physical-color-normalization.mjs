// Source-only regression: physical color normalization must not depend on SI scale.
// Does not mount React, open a browser or compile unit tests.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const root = fileURLToPath(new URL("../src/", import.meta.url));
const cache = new Map();

async function moduleAt(file) {
  if (cache.has(file)) return cache.get(file);
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new vm.SourceTextModule(output, { identifier: file });
  cache.set(file, mod);
  await mod.link(async spec => {
    assert.ok(spec.startsWith(".") || spec.startsWith("@/"), `Unexpected external dependency: ${spec}`);
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(file), spec);
    const target = [base, `${base}.ts`, path.join(base, "index.ts")].find(existsSync);
    assert.ok(target, `Unresolved ${spec} from ${file}`);
    return moduleAt(target);
  });
  return mod;
}

const mapping = await moduleAt(path.join(root, "modules/viewport-3d/viewport3dFieldMapping.ts"));
await mapping.evaluate();
const coloring = await moduleAt(path.join(root, "modules/viewport-3d/viewport3dVectorColoring.ts"));
await coloring.evaluate();
const palette = await moduleAt(path.join(root, "shared/visualization/scalarColorPalette.ts"));
await palette.evaluate();
const normalize = coloring.namespace.normalizeViewport3DScalarColorValue;
for (const [components, mode, scale] of [[1, "magnitude", 1e-8], [3, "magnitude", 1e-8], [3, "x", 1e-15]]) {
  const physical = [0, scale / 2, scale];
  const values = Float64Array.from(physical.flatMap(value => components === 1 ? [value] : [value, 0, 0]));
  const field = { nComp: components, pointCount: 3, values, indexing: "full_domain", quantityId: components === 1 ? "V_electric" : "H_ant" };
  const buffer = mapping.namespace.buildVertexScalarColors(field, 3, Infinity, mode, "inferno", { min: 0, max: scale });
  assert.ok(buffer);
  assert.deepEqual([...buffer.scalarValues], [0, 0.5, 1], "GPU scalar attribute must use the same SI-independent coordinate");
  for (let point = 0; point < 3; point++) {
    assert.deepEqual([...buffer.colors.subarray(point * 3, point * 3 + 3)],
      palette.namespace.scalarColorRgb(point / 2, "inferno").map(Math.fround), "CPU RGB must reach both endpoints and the midpoint");
  }
}
console.log("PASS production scalar/magnitude/component RGB and shader attributes at small SI scales");

for (const range of [{ min: 0, max: 1e-8 }, { min: 0, max: 1e-15 },
  { min: -1e-300, max: 1e-300 }, { min: -Number.MAX_VALUE, max: Number.MAX_VALUE },
  { min: 1, max: 1 + 4 * Number.EPSILON }, { min: -Number.MIN_VALUE, max: Number.MIN_VALUE }]) {
  assert.equal(normalize(range.min, range), 0);
  assert.equal(normalize(range.max, range), 1);
  const midpoint = range.min / 2 + range.max / 2;
  assert.ok(Math.abs(normalize(midpoint, range) - 0.5) < 1e-12);
}
assert.equal(normalize(7, { min: 1, max: 1 }), 0.5);
assert.equal(normalize(NaN, { min: 0, max: 1 }), 0.5);
assert.equal(normalize(-1, { min: 0, max: 1e-15 }), 0);
assert.equal(normalize(1, { min: 0, max: 1e-15 }), 1);
console.log("PASS tiny, narrow, subnormal and extreme finite ranges with endpoint clipping");
