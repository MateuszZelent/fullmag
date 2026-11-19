// Source-only regression of saved-result color ranges; no browser or native build.
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
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new vm.SourceTextModule(output, { identifier: file });
  cache.set(file, mod);
  return mod;
}
async function moduleAt(relative) {
  const mod = load(path.join(root, relative));
  if (mod.status === "unlinked") await mod.link((spec, parent) => {
    assert.ok(spec.startsWith(".") || spec.startsWith("@/"), `Unexpected dependency ${spec}`);
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(parent.identifier), spec);
    const file = [base, `${base}.ts`, path.join(base, "index.ts")].find(existsSync);
    assert.ok(file, `Unresolved ${spec}`);
    return load(file);
  });
  await mod.evaluate();
  return mod.namespace;
}
const controllerModule = await moduleAt("kernel/visualization/ObjectVisualizationController.ts");
const selection = await moduleAt("kernel/selection/selectionTypes.ts");
const adapter = await moduleAt("modules/viewport-3d/savedFieldViewportAdapter.ts");
const coloring = await moduleAt("modules/viewport-3d/viewport3dVectorColoring.ts");
const rendering = await moduleAt("modules/viewport-3d/viewport3dRenderModel.ts");
const palette = await moduleAt("shared/visualization/scalarColorPalette.ts");
const units = await moduleAt("shared/domain/physics/displayUnits.ts");
const visible = await moduleAt("modules/viewport-3d/model/viewport3DVisibleColorScale.ts");
const ref = selection.pinnedMaterializedDatasetSelectionRef({ projectId: "project", runId: "run", solutionSetId: "solution",
  containingRevision: "1", memberId: "member", artifactId: "artifact", manifestObjectRef: "manifest", sampleId: "sample",
  itemId: "item", fieldId: "field", datasetId: "dataset", datasetRevision: "1" });
const controller = new controllerModule.ObjectVisualizationController();
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const saved = () => controller.getSnapshot().savedFieldPresentation;
check("controller copies valid SI limits and preserves live overrides", () => {
  controller.setSavedFieldPresentation(ref, "H_ant", "3");
  const range = { minimum: -2, maximum: 2 };
  controller.setSavedFieldColorRange(ref, "x", range);
  range.maximum = 99;
  assert.equal(saved().colorRanges.x.maximum, 2);
  assert.deepEqual(controller.getSnapshot().overrides, {});
  assert.equal(saved().settings.activeQuantityId, "H_ant");
});
check("invalid and stale range edits preserve snapshot identity", () => {
  for (const range of [{ minimum: 1, maximum: 1 }, { minimum: 2, maximum: 1 },
    { minimum: NaN, maximum: 1 }, { minimum: 0, maximum: Infinity }]) {
    const before = controller.getSnapshot();
    controller.setSavedFieldColorRange(ref, "x", range);
    assert.strictEqual(controller.getSnapshot(), before);
  }
  const before = controller.getSnapshot();
  controller.setSavedFieldColorRange({ ...ref, manifestObjectRef: "foreign" }, "x", { minimum: -8, maximum: 8 });
  controller.setSavedFieldColorRange(ref, "orientation", { minimum: -8, maximum: 8 });
  assert.strictEqual(controller.getSnapshot(), before);
});
check("Auto is component-local and a new immutable result resets ranges", () => {
  controller.setSavedFieldColorRange(ref, "y", { minimum: -4, maximum: 4 });
  controller.setSavedFieldColorRange(ref, "x", undefined);
  assert.equal(saved().colorRanges.x, undefined);
  assert.equal(saved().colorRanges.y.maximum, 4);
  const before = controller.getSnapshot();
  controller.setSavedFieldPresentation({ ...ref }, "H_ant", "3");
  assert.strictEqual(controller.getSnapshot(), before);
  controller.setSavedFieldPresentation({ ...ref, manifestObjectRef: "next" }, "H_ant", "3");
  assert.equal(saved().colorRanges, undefined);
});

const geometry = { representation_evidence: "not_verified", geometry_manifest: { object_ref: "mesh" }, topology_fingerprint: "topology", owner_solution_revision: "1" };
const topology = { formatVersion: 2, nodeCount: 4, cellCount: 1, elementCount: 1, facetCount: 4, boundaryFaceCount: 4,
  positions: Float64Array.from([0,0,0, 1,0,0, 0,1,0, 0,0,1]), cells: Uint32Array.from([0,1,2,3]),
  boundaryFaces: Uint32Array.from([0,2,1, 0,1,3, 0,3,2, 1,2,3]) };
const field = { representationEvidence: "not_verified", nodeCount: 4, componentCount: 3, dtype: "f64", quantityId: "H_ant",
  values: Float64Array.from([1,2,0, 999,999,999, -1,-2,0, -999,-999,-999]), savedScopeKey: "saved", topologyFingerprint: "topology" };
const support = { nodeCount: 4, bits: Uint8Array.from([5]) };
const settings = { ...controllerModule.DEFAULT_OBJECT_VISUALIZATION, activeQuantityId: "H_ant", geometryScope: "full",
  shaderVisible: true, vectorsVisible: true, shaderColorMode: "x", surfaceColorSource: "component_x", vectorColorMode: "y",
  viewportColorbarVisible: true, scalarColorPalette: "inferno", vectorBudget: 4 };
const ranges = { x: { minimum: -2, maximum: 2 }, y: { minimum: -4, maximum: 4 } };
function build({ values = field, limits = ranges, config = settings, active = support } = {}) {
  return adapter.buildSavedFieldViewportSceneModel({ geometry, topology, field: values, support: active,
    palette: config.scalarColorPalette, vectorColorMode: config.vectorColorMode, vectorScale: 0.1, settings: config, colorRanges: limits });
}
function rgbAt(buffer, index) { return [...buffer.subarray(index * 3, index * 3 + 3)]; }
function expectedRgb(t, colorPalette = "inferno") { return [...Float32Array.from(palette.scalarColorRgb(t, colorPalette))]; }
function close(actual, expected) { assert.ok(Math.abs(actual - expected) <= 1e-6, `${actual} != ${expected}`); }
check("real sparse renderer keeps independent X/Y ranges and physical RGB", () => {
  const before = [...field.values], model = build();
  assert.ok(model?.fieldModel);
  const fm = model.fieldModel, pass = fm.targetPasses.get("full");
  assert.deepEqual({ ...pass.surface.scalarColors.range }, { min: -2, max: 2 });
  assert.deepEqual({ ...fm.scalarColorsByMode.get("y").range }, { min: -4, max: 4 });
  assert.deepEqual([...pass.vectors.nodeIndices], [0, 2]);
  for (const [glyph, t] of [[0, .75], [1, .25]]) assert.deepEqual(rgbAt(pass.vectors.glyphColors, glyph), expectedRgb(t));
  const changed = build({ limits: { ...ranges, x: { minimum: -8, maximum: 8 } } });
  assert.deepEqual([...changed.fieldModel.targetPasses.get("full").vectors.glyphColors], [...pass.vectors.glyphColors]);
  assert.notDeepEqual([...changed.fieldModel.targetPasses.get("full").surface.scalarColors.colors], [...pass.surface.scalarColors.colors]);
  assert.deepEqual([...field.values], before);
});
check("same-owner render cache isolates manual ranges and reuses identical limits", () => {
  const topologyModel = build().topologyModel;
  const sameField = { dtype: "float64", fieldGenerationId: "saved", grid: [4,1,1], indexing: "full_domain",
    meshTopologyHash: "topology", meshTopologyRevision: "mesh", nComp: 3, pointCount: 4, quantityId: "H_ant",
    scopeId: "saved", scopeKind: "full", sourceId: "saved", sourceRevision: "1", valueCount: 12,
    values: Float64Array.from([1,2,0, 2,4,0, -1,-2,0, -2,-4,0]) };
  const buffers = [];
  for (const maximum of [4, 8, 4]) {
    const model = rendering.buildViewport3DFieldRenderModel(topologyModel, sameField, .1, {
      fullScalarColorMode: "y", scalarColorModes: new Set(["y"]), scalarColorPalette: "inferno",
      vectorColorMode: "y", fullVectorBudget: 0, partVectorBudgets: new Map(),
      scalarRangesByMode: new Map([["y", { min: -maximum, max: maximum }]]) });
    const buffer = model.scalarColorsByMode.get("y");
    assert.deepEqual({ ...buffer.range }, { min: -maximum, max: maximum });
    buffers.push(buffer);
  }
  assert.notStrictEqual(buffers[0], buffers[1]);
  assert.strictEqual(buffers[0], buffers[2], "Unchanged owner and limits should hit the real cache");
  const auto = build({ limits: {} });
  assert.deepEqual({ ...auto.fieldModel.scalarColorsByMode.get("y").range }, { min: -2, max: 2 });
  assert.deepEqual({ ...auto.fieldModel.targetPasses.get("full").surface.scalarColors.range }, { min: -1, max: 1 });
});
check("tiny scalar SI ranges span CPU palette and shader values", () => {
  const values = { ...field, componentCount: 1, quantityId: "V_electric", values: Float64Array.from([0, 5e-9, 1e-8, 5e-9]) };
  const config = { ...settings, activeQuantityId: "V_electric", shaderColorMode: "magnitude", surfaceColorSource: "magnitude", vectorsVisible: false };
  const model = build({ values, config, active: { nodeCount: 4, bits: Uint8Array.from([15]) }, limits: { magnitude: { minimum: 0, maximum: 1e-8 } } });
  const buffer = model.fieldModel.targetPasses.get("full").surface.scalarColors;
  for (const [node, t] of [[0, 0], [1, .5], [2, 1]]) {
    assert.deepEqual(rgbAt(buffer.colors, node), expectedRgb(t));
    close(buffer.scalarValues[node], t);
  }
  assert.equal(model.fieldModel.targetPasses.get("full").vectors.segments, null);
});
check("tiny signed component uses the same physical range for CPU shader and glyph colors", () => {
  const values = { ...field, values: Float64Array.from([0,0,0, 5e-16,0,0, 1e-15,0,0, 5e-16,0,0]) };
  const config = { ...settings, vectorColorMode: "x" };
  const model = build({ values, config, active: { nodeCount: 4, bits: Uint8Array.from([15]) }, limits: { x: { minimum: 0, maximum: 1e-15 } } });
  const pass = model.fieldModel.targetPasses.get("full"), buffer = pass.surface.scalarColors;
  for (const [node, t] of [[0, 0], [1, .5], [2, 1]]) {
    assert.deepEqual(rgbAt(buffer.colors, node), expectedRgb(t));
    close(buffer.scalarValues[node], t);
  }
  for (let glyph = 0; glyph < pass.vectors.nodeIndices.length; glyph++) {
    const node = pass.vectors.nodeIndices[glyph];
    assert.deepEqual(rgbAt(pass.vectors.glyphColors, glyph), rgbAt(buffer.colors, node));
  }
});
check("canonical normalization handles finite extremes and narrow nonzero SI spans", () => {
  const normalize = coloring.normalizeViewport3DScalarColorValue;
  for (const [range, values] of [[{ min: -1e308, max: 1e308 }, [-1e308, 0, 1e308]],
    [{ min: 0, max: 1e-300 }, [0, 5e-301, 1e-300]]]) {
    values.forEach((value, index) => close(normalize(value, range), index / 2));
  }
  assert.equal(normalize(-2, { min: -1, max: 1 }), 0);
  assert.equal(normalize(2, { min: -1, max: 1 }), 1);
});

const viewportFile = path.join(root, "modules/viewport-3d/Viewport3DModule.tsx");
const tree = ts.createSourceFile(viewportFile, readFileSync(viewportFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["resolveSavedFieldColorbars", "resolveViewport3DColorbarLegend", "formatViewport3DColorbarQuantityLabel"];
const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(declarations.length, names.length);
const context = vm.createContext({ normalizeDisplayUnit: units.normalizeDisplayUnit, formatValueWithDisplayUnit: units.formatValueWithDisplayUnit,
  viewport3DColorPaletteGradientCss: coloring.viewport3DColorPaletteGradientCss });
vm.runInContext(ts.transpileModule(declarations.map(node => node.getText(tree)).join("\n").replace(/^export /gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
function legends(model, config = settings, quantityId = "H_ant", unit = "A/m") {
  const pass = model.fieldModel.targetPasses.get("full");
  let scales = { scopeKey: "saved-test-scope", passes: {} };
  for (const [name, buffer] of [["surface", pass.surface.scalarColors],
    ["vectors", pass.vectors.segments ? model.fieldModel.scalarColorsByMode.get(config.vectorColorMode) : null]]) {
    scales = visible.updateVisibleColorScales(scales, { scopeKey: scales.scopeKey, ownerId: name,
      pass: name, scale: visible.visibleColorScaleFromBuffer(buffer) });
  }
  context.input = { scales, scopeKey: scales.scopeKey, settings: config, quantityId, unit };
  return vm.runInContext("resolveSavedFieldColorbars(input)", context);
}
check("real saved legends expose independent physical components and deduplicate identical scales", () => {
  const model = build(), result = legends(model);
  assert.equal(result.length, 2);
  for (const legend of result.map(item => item.legend)) {
    assert.equal(legend.quantityId, "H_ant"); assert.equal(legend.sourceUnit, "A/m");
    const buffer = model.fieldModel.scalarColorsByMode.get(legend.colorMode);
    assert.deepEqual({ ...legend.range }, { ...buffer.range });
    assert.equal(legend.paletteGradient, coloring.viewport3DColorPaletteGradientCss("inferno"));
  }
  const config = { ...settings, vectorColorMode: "x" };
  const combined = legends(build({ config }), config);
  assert.equal(combined.length, 1);
  assert.ok(combined[0].legend.labelPrefix.includes("surface / vectors"));
  for (const patch of [{ visible: false }, { viewportColorbarVisible: false }, { shaderVisible: false, vectorsVisible: false }]) {
    assert.equal(legends(model, { ...settings, ...patch }).length, 0);
  }
});
check("orientation has no numerical legend and scalar cannot gain a vector legend", () => {
  const config = { ...settings, shaderColorMode: "orientation", surfaceColorSource: "orientation", vectorColorMode: "orientation" };
  assert.equal(legends(build({ config }), config).length, 0);
  const values = { ...field, componentCount: 1, quantityId: "V_electric", values: Float64Array.from([0,1,2,3]) };
  const scalarConfig = { ...settings, activeQuantityId: "V_electric", shaderColorMode: "magnitude", surfaceColorSource: "magnitude" };
  const model = build({ values, config: scalarConfig, limits: { magnitude: { minimum: 0, maximum: 4 } } });
  const result = legends(model, scalarConfig, "V_electric", "V");
  assert.equal(result.length, 1); assert.equal(result[0].legend.sourceUnit, "V");
  assert.deepEqual({ ...result[0].legend.range }, { min: 0, max: 4 });
  assert.equal(model.fieldModel.targetPasses.get("full").vectors.segments, null);
});
console.log(JSON.stringify({ status: "passed", checks, scope: "source-only saved range controller, real renderer and legend functions",
  browser_verified: false, async_retained_legend_verified: false, unit_test_compilation: false }));
