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

const geometry = { representation_evidence: "not_verified", geometry_manifest: { object_ref: "mesh" }, topology_fingerprint: "topology", owner_solution_revision: "1" };
const field = { representationEvidence: "not_verified", nodeCount: 4, componentCount: 3, dtype: "f64", quantityId: "H_ant",
  values: new Float64Array(12), savedScopeKey: "saved-key", topologyFingerprint: "topology" };
const support = { nodeCount: 4, bits: new Uint8Array([5]) };
const realAdapter = await moduleAt(path.join(root, "modules/viewport-3d/savedFieldViewportAdapter.ts"));
await realAdapter.evaluate();
const layerInputs = await moduleAt(path.join(root, "modules/viewport-3d/layers/viewport3DLayerPassInputs.ts"));
await layerInputs.evaluate();
const realTopology = { formatVersion: 2, nodeCount: 4, cellCount: 1, elementCount: 1, facetCount: 4, boundaryFaceCount: 4,
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  cells: new Uint32Array([0, 1, 2, 3]), boundaryFaces: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};
const realField = { ...field, values: new Float64Array([1, 0, 0, 9, 9, 9, 0, 2, 0, 8, 8, 8]) };
for (const budget of [2, 1, 0]) {
  const realModel = realAdapter.namespace.buildSavedFieldViewportSceneModel({ geometry, topology: realTopology, field: realField,
    support, palette: "inferno", vectorColorMode: "magnitude", vectorScale: 0.1,
    settings: { shaderColorMode: "magnitude", vectorBudget: budget }, sceneVectorCap: 2048 });
  assert.ok(realModel);
  const vectors = layerInputs.namespace.resolveViewport3DTargetVectorLayerInput({ fieldModel: realModel.fieldModel, partId: "full" });
  if (budget === 0) {
    assert.equal(vectors.segments, null);
    continue;
  }
  assert.ok(vectors.buildReference);
  assert.ok(vectors.segments?.length > 0, "Sparse active support must reach the actual fallback vector layer");
  assert.ok([...vectors.segments].every(Number.isFinite));
  assert.equal(vectors.segments.length / 7, budget);
  for (let offset = 0; offset < vectors.segments.length; offset += 7) {
    const center = [0, 1, 2].map(axis => (vectors.segments[offset + axis] + vectors.segments[offset + axis + 3]) / 2);
    assert.ok([[0, 0, 0], [0, 1, 0]].some(point => point.every((value, axis) => Math.abs(value - center[axis]) < 1e-6)),
      "Only active nodes 0 and 2 may anchor glyphs");
  }
  assert.equal(realModel.fieldModel.fullVectorBuild, vectors.buildReference);
  assert.equal(realModel.fieldModel.fullVectorSegments, vectors.segments);
}
const realScalar = realAdapter.namespace.buildSavedFieldViewportSceneModel({ geometry, topology: realTopology,
  field: { ...realField, componentCount: 1, quantityId: "V_electric", values: new Float64Array([1, 2, 3, 4]) },
  support, palette: "inferno", vectorColorMode: "magnitude", vectorScale: 0.1,
  settings: { shaderColorMode: "magnitude", vectorBudget: 2 } });
assert.ok(realScalar);
assert.equal(layerInputs.namespace.resolveViewport3DTargetVectorLayerInput({ fieldModel: realScalar.fieldModel, partId: "full" }).segments, null);
console.log("PASS real renderer and fallback preserve sparse support with bounded vectors");

// Physical colors must follow producer samples, not normalized arrow endpoints.
for (const mode of ["x", "y", "z", "magnitude", "orientation"]) {
  const samples = { ...realField, values: new Float64Array([1, 2, 3, 0, 0, 0, 10, 20, 30, -4, -8, -12]) };
  const make = (palette, vectorScale, mask = 13) => realAdapter.namespace.buildSavedFieldViewportSceneModel({
    geometry, topology: realTopology, field: samples, support: { nodeCount: 4, bits: new Uint8Array([mask]) },
    palette, vectorColorMode: mode, vectorScale,
    settings: { shaderColorMode: mode, vectorBudget: 4 }, sceneVectorCap: 2048,
  });
  const scene = make("inferno", 0.1);
  const pass = scene.fieldModel.targetPasses.get("full").vectors;
  assert.deepEqual([...pass.nodeIndices], [0, 2, 3], "Glyph provenance must retain actual active source nodes");
  const layer = layerInputs.namespace.resolveViewport3DTargetVectorLayerInput({ fieldModel: scene.fieldModel, partId: "full" });
  const physicalColors = scene.fieldModel.scalarColorsByMode.get(mode).colors;
  assert.equal(layer.glyphColors.length, 9);
  for (let glyph = 0; glyph < pass.nodeIndices.length; glyph++) {
    const node = pass.nodeIndices[glyph];
    assert.deepEqual([...layer.glyphColors.subarray(glyph * 3, glyph * 3 + 3)],
      [...physicalColors.subarray(node * 3, node * 3 + 3)], "Glyph RGB must use the same physical scalar range and palette as the legend");
  }
  const otherScale = make("inferno", 0.8);
  assert.deepEqual([...otherScale.fieldModel.targetPasses.get("full").vectors.glyphColors], [...layer.glyphColors],
    "Arrow display length must not change physical colors");
  if (mode !== "orientation") {
    assert.notDeepEqual([...layer.glyphColors.subarray(0, 3)], [...layer.glyphColors.subarray(3, 6)],
      "Collinear fields with different amplitudes must have different quantitative colors");
    assert.notDeepEqual([...make("viridis", 0.1).fieldModel.targetPasses.get("full").vectors.glyphColors], [...layer.glyphColors],
      "Selected palette must reach glyph colors");
  }
  const allNodes = make("inferno", 0.1, 15);
  assert.deepEqual([...allNodes.fieldModel.targetPasses.get("full").vectors.nodeIndices], [0, 2, 3],
    "Zero vectors must be omitted without shifting color-to-source alignment");
}
console.log("PASS saved glyph physical component colors, palette, zero vectors and scale independence");

const mapping = await moduleAt(path.join(root, "modules/viewport-3d/viewport3dFieldMapping.ts"));
await mapping.evaluate();
for (const mode of ["x", "y", "z", "magnitude", "orientation"]) {
  for (const palette of ["inferno", "viridis"]) {
    for (const mask of [5, 13, 15]) {
      const values = new Float64Array([1, 2, 3, 0, 0, 0, 10, 20, 30, -4, -8, -12]);
      const activeNodes = [0, 1, 2, 3].filter(node => mask & (1 << node));
      const activeValues = Float64Array.from(activeNodes.flatMap(node => [...values.subarray(node * 3, node * 3 + 3)]));
      const expected = mapping.namespace.buildVertexScalarColors({ nComp: 3, pointCount: activeNodes.length,
        values: activeValues, indexing: "full_domain", quantityId: "H_ant" }, activeNodes.length, Infinity, mode, palette);
      assert.ok(expected, "Canonical physical color mapping must be available");
      for (const budget of [0, 1, 2, 4]) {
        const scene = realAdapter.namespace.buildSavedFieldViewportSceneModel({
          geometry, topology: realTopology, field: { ...realField, values }, support: { nodeCount: 4, bits: new Uint8Array([mask]) },
          palette, vectorColorMode: mode, vectorScale: 0.1,
          settings: { shaderColorMode: mode, vectorBudget: budget }, sceneVectorCap: 2,
        });
        assert.ok(scene);
        assert.equal(scene.carrier.role, "saved-domain");
        assert.equal(scene.carrier.object_id, null);
        assert.equal(scene.femDomain.airboxParts.length, 0);
        assert.equal(scene.femDomain.magneticParts.length, 0);
        const full = scene.fieldModel.targetPasses.get("full").vectors;
        const owned = scene.fieldModel.targetPasses.get(scene.carrier.id).vectors;
        const layer = layerInputs.namespace.resolveViewport3DTargetVectorLayerInput({ fieldModel: scene.fieldModel, partId: "full" });
        if (budget === 0) {
          assert.equal(layer.segments, null);
          continue;
        }
        assert.ok(full.nodeIndices && full.segments && layer.glyphColors);
        assert.ok(full.nodeIndices.length <= Math.min(budget, 2));
        assert.equal(full.nodeIndices.length * 7, full.segments.length);
        assert.equal(full.nodeIndices.length * 3, layer.glyphColors.length);
        assert.strictEqual(layer.buildReference, full.buildReference);
        assert.strictEqual(layer.segments, full.segments);
        assert.strictEqual(layer.glyphColors, full.glyphColors);
        if (mask !== 15) {
          assert.strictEqual(full.buildReference, owned.buildReference, "Sparse FULL must retain the owned source build reference");
          assert.strictEqual(full.segments, owned.segments, "Sparse FULL must alias the owned source geometry");
          assert.strictEqual(full.nodeIndices, owned.nodeIndices, "Sparse FULL must preserve actual source node indices");
        }
        for (let glyph = 0; glyph < full.nodeIndices.length; glyph++) {
          const node = full.nodeIndices[glyph], active = activeNodes.indexOf(node);
          assert.notEqual(active, -1, "Inactive nodes must never acquire glyph colors");
          assert.ok(Math.hypot(...values.subarray(node * 3, node * 3 + 3)) > 0, "Zero vectors must not shift color indexing");
          assert.deepEqual([...layer.glyphColors.subarray(glyph * 3, glyph * 3 + 3)],
            [...expected.colors.subarray(active * 3, active * 3 + 3)],
            `${mode}/${palette} RGB must match the canonical full active-carrier physical mapping`);
        }
      }
    }
  }
}
console.log("PASS canonical physical mapping for all components, both palettes, sparse masks and glyph budgets");

// Check both seams without mounting React/WebGL: the real resolver above emits
// RGB, and the production fallback must pass it through to VectorFieldLayer.
const fallbackFile = path.join(root, "modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx");
const fallback = ts.createSourceFile(fallbackFile, readFileSync(fallbackFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const properties = new Map();
function findFallbackBindings(node) {
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ["FallbackTopologyMeshPrimitives", "VectorFieldLayer"].includes(node.tagName.getText(fallback))) {
    properties.set(node.tagName.getText(fallback), new Map(node.attributes.properties
      .filter(ts.isJsxAttribute).map(attribute => [attribute.name.getText(fallback), attribute.initializer?.expression?.getText(fallback)])));
  }
  ts.forEachChild(node, findFallbackBindings);
}
findFallbackBindings(fallback);
assert.equal(properties.get("FallbackTopologyMeshPrimitives")?.get("vectorGlyphColors"), "vectorLayerInput.glyphColors ?? null");
assert.equal(properties.get("VectorFieldLayer")?.get("glyphColorsOverride"), "vectorGlyphColors");
console.log("PASS production fallback forwards the same physical RGB to the glyph layer");
