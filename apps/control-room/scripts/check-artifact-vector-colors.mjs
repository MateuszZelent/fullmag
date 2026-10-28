// Source-only regression: physical artifact vector colors and real legend functions.
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

function load(file) {
  if (cache.has(file)) return cache.get(file);
  let source = readFileSync(file, "utf8");
  if (file.endsWith("/model/artifactFieldOverlayModel.ts")) {
    // Exercise the production geometry/presentation path without importing the
    // unrelated Universe owner routing currently being developed in this file.
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    source = tree.statements.filter(node =>
      ts.isImportDeclaration(node) && !node.moduleSpecifier.text.includes("artifactFieldSelection")
      || ts.isFunctionDeclaration(node) && ["prepareArtifactFieldOverlay", "presentArtifactFieldOverlay", "buildArtifactFieldOverlayModel"].includes(node.name?.text)
    ).map(node => node.getText(tree)).join("\n");
  }
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new vm.SourceTextModule(output, { identifier: file });
  cache.set(file, mod);
  return mod;
}

async function moduleAt(file) {
  const mod = load(file);
  if (mod.status === "unlinked") await mod.link((spec, parent) => {
    assert.ok(spec.startsWith(".") || spec.startsWith("@/"), `Unexpected external dependency: ${spec}`);
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(parent.identifier), spec);
    const target = [base, `${base}.ts`, path.join(base, "index.ts")].find(existsSync);
    assert.ok(target, `Unresolved ${spec} from ${parent.identifier}`);
    return load(target);
  });
  return mod;
}

const entry = await moduleAt(path.join(root, "modules/viewport-3d/model/artifactFieldOverlayModel.ts"));
await entry.evaluate();
const { buildArtifactFieldOverlayModel: build } = entry.namespace;
const carrierModule = await moduleAt(path.join(root, "modules/viewport-3d/model/artifactFieldCarrierModel.ts"));
await carrierModule.evaluate();
const carrier = carrierModule.namespace;
const digest = "a".repeat(64), content = `sha256:${"b".repeat(64)}`, source = `sha256:${"c".repeat(64)}`;
const owner = Object.fromEntries(["session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id", "authored_stage_id", "module_id", "object_id", "output_id", "native_mesh_identity", "native_topology_identity"].map(key => [key, key]));
Object.assign(owner, { source_digest: source, content_digest: content, historical_inspection: true });
const positions = Float64Array.from([0,0,0, 1,0,0, 0,1,0, 0,0,1, 0,0,0, 0,1,0, 1,0,0, 0,0,-1]);
const first = 9007199254740992n;
const ids = BigUint64Array.from([first,first+1n,first+2n,first+3n, first,first+2n,first+1n,first+4n]);
const locator = { carrier_scope_kind: "object", carrier_scope_id: "object_id", carrier_id: `artifact:${digest}:tet4_cell_local_nodes`, carrier_digest: digest, carrier_revision: "1", indexing: "tet4_cell_local_nodes", sample_count: 8, coordinate_frame: "world", coordinate_unit: "m", topology_binary_schema: "FMMT.v2", owner };
const mapping = { indexing: "tet4_cell_local_nodes", identityIds: ids, elementOrdinals: BigUint64Array.from([10n,10n,10n,10n,20n,20n,20n,20n]), localVertexIndices: Uint8Array.from([0,1,2,3,0,1,2,3]) };
const values = Float64Array.from([1,2,3, 2,3,4, 3,4,5, 4,5,6, -10,-20,-30, -20,-30,-40, -30,-40,-50, -40,-50,-60]);
const field = { formatVersion: 6, sourceKind: "artifact_inspection", artifactMapping: mapping, domainGenerationId: digest, meshTopologyHash: digest, meshTopologyRevision: "1", sourceId: source, fieldGenerationId: content, scopeKind: "object", scopeId: "object_id", indexing: "tet4_cell_local_nodes", pointCount: 8, quantityId: "J_charge", nComp: 3, values, sourceRevision: "2" };
const topology = { formatVersion: 2, nodeCount: 8, positions, cellTypes: Uint32Array.from([1,1]), cellOffsets: Uint32Array.from([0,4,8]), cellNodes: Uint32Array.from([0,1,2,3,4,5,6,7]) };
const headers = { carrierId: locator.carrier_id, carrierDigest: digest, carrierRevision: "1", identityIssues: [] }, geometry = { ...headers, coordinateFrame: "world", coordinateUnit: "m" };
const settings = { shaderColorMode: "x", vectorsVisible: true, vectorBudget: 8, vectorLengthScale: 1, vectorCenteringEnabled: false, scalarColorPalette: "viridis", vectorColorMode: "magnitude", shaderVisible: true, wireframeVisible: true };
function fixture() { return structuredClone({ locator, field, topology, headers, geometry, settings }); }
function render(f) { return build(carrier.admitArtifactFieldCarrier(f.locator, f.field, f.headers, f.topology, f.geometry), f.settings); }
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }

const glyphBuild = await moduleAt(path.join(root, "modules/viewport-3d/layers/vectorGlyphBuildModel.ts"));
await glyphBuild.evaluate();
const paletteModule = await moduleAt(path.join(root, "shared/visualization/scalarColorPalette.ts"));
await paletteModule.evaluate();
const palette = paletteModule.namespace;

function vectorFixture(quantity) {
  const f = fixture();
  Object.assign(f.settings, { visible: true, viewportColorbarVisible: true, shaderVisible: false, wireframeVisible: false });
  if (quantity === "H_ant") {
    const indexing = "point_samples", count = 7;
    Object.assign(f.locator, { indexing, sample_count: count, carrier_id: `artifact:${digest}:${indexing}` });
    Object.assign(f.field, { quantityId: quantity, pointCount: count, indexing,
      values: Float64Array.from([1,-2,3, 8,-16,24, -3,6,-9, 2,-4,6, 0,0,0, -1,2,-3, 4,-8,12]),
      artifactMapping: { indexing, identityIds: BigUint64Array.from([0n,1n,2n,3n,4n,5n,6n]), elementOrdinals: null, localVertexIndices: null } });
    Object.assign(f.topology, { positions: Float64Array.from(Array.from({length: count}, (_, i) => [0,0,i]).flat()), nodeCount: count,
      cellTypes: undefined, cellOffsets: undefined, cellNodes: undefined });
    f.headers.carrierId = f.geometry.carrierId = f.locator.carrier_id;
    f.settings.vectorBudget = count;
  }
  return f;
}

for (const quantity of ["H_ant", "J_charge"]) {
  check(`${quantity} physical components retain full-carrier ranges and supported palettes`, () => {
    const f = vectorFixture(quantity), rawBefore = [...f.field.values];
    for (const mode of ["x", "y", "z"]) for (const colorPalette of ["inferno", "coolwarm"]) {
      assert.equal(palette.normalizeScalarColorPalette(colorPalette), colorPalette, "Use the actual supported palette");
      const axis = { x: 0, y: 1, z: 2 }[mode];
      const components = Array.from({length: f.field.pointCount}, (_, i) => f.field.values[i * 3 + axis]);
      const min = Math.min(...components), max = Math.max(...components), extent = Math.max(Math.abs(min), Math.abs(max));
      const range = colorPalette === "coolwarm" ? { min: -extent, max: extent } : { min, max };
      const settings = { ...f.settings, vectorColorMode: mode, scalarColorPalette: colorPalette };
      const full = render({ ...f, settings });
      const small = render({ ...f, settings: { ...settings, vectorBudget: 3, vectorLengthScale: 3 } });
      for (const model of [full, small]) {
        assert.deepEqual(model.vectorColorRange, range, "Unsampled extrema must retain the same physical range");
        for (let glyph = 0; glyph < model.glyphCount; glyph++) {
          const node = model.vectorSampleIndices[glyph];
          const t = Math.max(0, Math.min(1, (f.field.values[node * 3 + axis] - range.min) / Math.max(range.max - range.min, 1e-12)));
          assert.deepEqual([...model.glyphColors.subarray(glyph * 3, glyph * 3 + 3)], [...Float32Array.from(palette.scalarColorRgb(t, colorPalette))]);
        }
        const built = glyphBuild.namespace.buildViewport3DVectorGlyphs({ segments: model.vectorSegments, colorMode: mode, colorsOverride: model.glyphColors });
        assert.equal(built.transforms.count, model.glyphCount);
        assert.deepEqual([...built.colors], [...model.glyphColors]);
        assert.notStrictEqual(built.colors.buffer, model.glyphColors.buffer, "Worker result must own its physical RGB");
      }
      for (let glyph = 0; glyph < small.glyphCount; glyph++) {
        const node = small.vectorSampleIndices[glyph];
        assert.deepEqual([...small.glyphColors.subarray(glyph * 3, glyph * 3 + 3)], [...full.glyphColors.subarray(node * 3, node * 3 + 3)]);
      }
    }
    assert.deepEqual([...f.field.values], rawBefore, "Presentation must preserve the scientific field");
  });
  check(`${quantity} magnitude remains physical; orientation and monochrome have no numerical override`, () => {
    const f = vectorFixture(quantity), norms = Array.from({length: f.field.pointCount}, (_, i) => Math.hypot(...f.field.values.subarray(i * 3, i * 3 + 3)));
    const maximum = Math.max(...norms);
    for (const colorPalette of ["inferno", "coolwarm"]) {
      const model = render({ ...f, settings: { ...f.settings, vectorColorMode: "magnitude", scalarColorPalette: colorPalette } });
      assert.deepEqual(model.vectorColorRange, { min: 0, max: maximum });
      for (let glyph = 0; glyph < model.glyphCount; glyph++) {
        const node = model.vectorSampleIndices[glyph];
        assert.deepEqual([...model.glyphColors.subarray(glyph * 3, glyph * 3 + 3)], [...Float32Array.from(palette.scalarColorRgb(norms[node] / maximum, colorPalette))]);
      }
    }
    for (const vectorColorMode of ["orientation", "monochrome"]) {
      const model = render({ ...f, settings: { ...f.settings, vectorColorMode } });
      assert.equal(model.vectorColorRange, null);
      assert.equal(model.glyphColors, null);
    }
  });
}

const scalarFixture = fixture(), indexing = "source_nodes";
Object.assign(scalarFixture.locator, { indexing, sample_count: 4, carrier_id: `artifact:${digest}:${indexing}` });
Object.assign(scalarFixture.field, { quantityId: "V_electric", nComp: 1, pointCount: 4, indexing, values: Float64Array.from([-2,0,1,4]),
  artifactMapping: { indexing, identityIds: ids.slice(0,4), elementOrdinals: null, localVertexIndices: null } });
Object.assign(scalarFixture.topology, { positions: positions.slice(0,12), nodeCount: 4, cellTypes: Uint32Array.from([1]), cellOffsets: Uint32Array.from([0,4]), cellNodes: Uint32Array.from([0,1,2,3]) });
scalarFixture.headers.carrierId = scalarFixture.geometry.carrierId = scalarFixture.locator.carrier_id;
check("scalar potential never acquires vector colors or arrows", () => {
  const model = render(scalarFixture);
  assert.equal(model.scalar, true); assert.equal(model.unit, "V");
  assert.equal(model.glyphCount, 0); assert.equal(model.vectorSegments, null);
  assert.equal(model.vectorColorRange, null); assert.equal(model.glyphColors, null);
});

const layerFile = path.join(root, "modules/viewport-3d/layers/ArtifactFieldLayer.tsx");
const layer = ts.createSourceFile(layerFile, readFileSync(layerFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let overrideExpression;
function findOverride(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(layer) === "glyphColorsOverride") overrideExpression = node.initializer.expression.getText(layer);
  ts.forEachChild(node, findOverride);
}
findOverride(layer); assert.ok(overrideExpression);
const viewportFile = path.join(root, "modules/viewport-3d/Viewport3DModule.tsx");
const viewport = ts.createSourceFile(viewportFile, readFileSync(viewportFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const legendFunctions = ["resolveArtifactFieldColorbars", "resolveViewport3DColorbarLegend", "formatViewport3DColorbarQuantityLabel"];
const legendCode = viewport.statements.filter(node => ts.isFunctionDeclaration(node) && legendFunctions.includes(node.name?.text)).map(node => node.getText(viewport)).join("\n");
const displayUnits = await moduleAt(path.join(root, "shared/domain/physics/displayUnits.ts")); await displayUnits.evaluate();
const coloring = await moduleAt(path.join(root, "modules/viewport-3d/viewport3dVectorColoring.ts")); await coloring.evaluate();
const context = vm.createContext({ normalizeDisplayUnit: displayUnits.namespace.normalizeDisplayUnit,
  formatValueWithDisplayUnit: displayUnits.namespace.formatValueWithDisplayUnit,
  viewport3DColorPaletteGradientCss: coloring.namespace.viewport3DColorPaletteGradientCss });
vm.runInContext(ts.transpileModule(legendCode.replace(/^export /gm, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
check("real artifact layer and real legend functions share quantity, units, physical range and palette", () => {
  for (const quantity of ["H_ant", "J_charge"]) for (const mode of ["x", "y", "z", "magnitude", "orientation", "monochrome"]) {
    for (const colorPalette of ["inferno", "coolwarm"]) {
      const f = vectorFixture(quantity); Object.assign(f.settings, { vectorColorMode: mode, scalarColorPalette: colorPalette });
      const model = render(f), passed = new vm.Script(overrideExpression).runInNewContext({ model });
      assert.strictEqual(passed, model.glyphColors);
      context.model = model;
      const legends = vm.runInContext("resolveArtifactFieldColorbars(model)", context);
      assert.equal(legends.length, model.vectorColorRange ? 1 : 0);
      if (model.vectorColorRange) {
        const legend = legends[0].legend, unit = quantity === "H_ant" ? "A/m" : "A/m^2";
        assert.equal(legend.quantityId, quantity); assert.equal(legend.sourceUnit, unit);
        assert.equal(legend.colorMode, mode); assert.deepEqual({ ...legend.range }, { ...model.vectorColorRange });
        assert.equal(legend.paletteGradient, coloring.namespace.viewport3DColorPaletteGradientCss(colorPalette));
        assert.ok(legend.label.includes(quantity)); assert.ok(legend.label.includes(unit));
      }
      for (const patch of [{ visible: false }, { vectorsVisible: false }, { viewportColorbarVisible: false }, { vectorBudget: 0 }]) {
        context.model = render({ ...f, settings: { ...f.settings, ...patch } });
        assert.equal(vm.runInContext("resolveArtifactFieldColorbars(model)", context).length, 0);
      }
    }
  }
});
console.log(`PASS ${checks} focused artifact vector color checks; browser/WebGL NOT VERIFIED`);
