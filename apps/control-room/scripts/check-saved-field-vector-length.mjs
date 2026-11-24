// Source-only regression: saved carrier support, physical RGB and fallback wiring.
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

function moduleAt(file) {
  if (cache.has(file)) return cache.get(file);
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new vm.SourceTextModule(output, { identifier: file });
  cache.set(file, mod);
  return mod;
}

function linkDependency(spec, parent) {
  assert.ok(spec.startsWith(".") || spec.startsWith("@/"), `Unexpected external dependency: ${spec}`);
  const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(parent.identifier), spec);
  const target = [base, `${base}.ts`, path.join(base, "index.ts")].find(existsSync);
  assert.ok(target, `Unresolved ${spec} from ${parent.identifier}`);
  // VM owns recursive linking, including shared and cyclic dependencies.
  return moduleAt(target);
}

async function loadModule(file) {
  const mod = moduleAt(file);
  if (mod.status === "unlinked") await mod.link(linkDependency);
  await mod.evaluate();
  return mod;
}

const geometry = { representation_evidence: "not_verified", geometry_manifest: { object_ref: "mesh" }, topology_fingerprint: "topology", owner_solution_revision: "1" };
const field = { representationEvidence: "not_verified", nodeCount: 4, componentCount: 3, dtype: "f64", quantityId: "H_ant",
  values: new Float64Array(12), savedScopeKey: "saved-key", topologyFingerprint: "topology" };
const realAdapter = await loadModule(path.join(root, "modules/viewport-3d/savedFieldViewportAdapter.ts"));
const layerInputs = await loadModule(path.join(root, "modules/viewport-3d/layers/viewport3DLayerPassInputs.ts"));
const realTopology = { formatVersion: 2, nodeCount: 4, cellCount: 1, elementCount: 1, facetCount: 4, boundaryFaceCount: 4,
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  cells: new Uint32Array([0, 1, 2, 3]), boundaryFaces: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};
const realField = { ...field, values: new Float64Array([1, 0, 0, 9, 9, 9, 0, 2, 0, 8, 8, 8]) };
// Assert actual segment lengths through the production full-target resolver.
for (const mask of [15, 5]) {
  const build = vectorLengthScale => realAdapter.namespace.buildSavedFieldViewportSceneModel({
    geometry, topology: realTopology, field: realField,
    support: { nodeCount: 4, bits: new Uint8Array([mask]) },
    palette: "inferno", vectorColorMode: "magnitude", vectorScale: 0.1,
    settings: { shaderColorMode: "magnitude", vectorBudget: 4, vectorLengthScale },
  });
  const one = build(1), two = build(2);
  for (const target of ["full", one.carrier.id]) {
    const first = layerInputs.namespace.resolveViewport3DTargetVectorLayerInput({ fieldModel: one.fieldModel, partId: target });
    const second = layerInputs.namespace.resolveViewport3DTargetVectorLayerInput({ fieldModel: two.fieldModel, partId: target });
    assert.ok(first.segments?.length > 0);
    assert.equal(first.segments.length, second.segments.length);
    assert.notEqual(first.buildReference.buildKey, second.buildReference.buildKey);
    for (let offset = 0; offset < first.segments.length; offset += 7) {
      const length = segments => Math.hypot(...[0, 1, 2].map(axis => segments[offset + axis + 3] - segments[offset + axis]));
      assert.ok(Math.abs(length(second.segments) / length(first.segments) - 2) < 1e-5,
        `mask=${mask} target=${target}: display length must double`);
      for (const axis of [0, 1, 2]) {
        const center = segments => (segments[offset + axis] + segments[offset + axis + 3]) / 2;
        assert.ok(Math.abs(center(first.segments) - center(second.segments)) < 1e-6);
      }
      assert.equal(first.segments[offset + 6], second.segments[offset + 6]);
    }
    assert.deepEqual([...first.glyphColors], [...second.glyphColors]);
  }
}
console.log("PASS saved glyph length doubles for full and sparse carriers; anchors, physical colors and magnitudes unchanged");
