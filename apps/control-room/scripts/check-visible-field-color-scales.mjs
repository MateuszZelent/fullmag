// Source-only visible-scale regression; actual production reducers, worker envelope,
// surface-retention declarations and upload hook/manager. No browser or GPU draw.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript"), Three = await import("three");
const root = fileURLToPath(new URL("../src/", import.meta.url));
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const mod = new vm.SourceTextModule(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText, { identifier: file }); modules.set(file, mod); return mod;
}
async function moduleAt(relative) {
  const mod = load(path.join(root, relative));
  if (mod.status === "unlinked") await mod.link((spec, parent) => {
    if (spec === "three") {
      if (!modules.has("three")) modules.set("three", new vm.SyntheticModule(Object.keys(Three), function () {
        for (const [name, value] of Object.entries(Three)) this.setExport(name, value);
      }));
      return modules.get("three");
    }
    assert.ok(spec.startsWith(".") || spec.startsWith("@/"), `Unexpected dependency ${spec}`);
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(parent.identifier), spec);
    const file = [base, `${base}.ts`, path.join(base, "index.ts")].find(existsSync); assert.ok(file); return load(file);
  });
  await mod.evaluate(); return mod.namespace;
}
function source(relative, kind = ts.ScriptKind.TS) {
  const file = path.join(root, relative);
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}
function execute(text, bindings = {}) {
  const context = vm.createContext(bindings);
  vm.runInContext(ts.transpileModule(text.replace(/^export /gm, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}
const visible = await moduleAt("modules/viewport-3d/model/viewport3DVisibleColorScale.ts");
const mapping = await moduleAt("modules/viewport-3d/viewport3dFieldMapping.ts");
const glyphs = await moduleAt("modules/viewport-3d/layers/vectorGlyphBuildModel.ts");
const units = await moduleAt("shared/domain/physics/displayUnits.ts");
const coloring = await moduleAt("modules/viewport-3d/viewport3dVectorColoring.ts");
const gpu = await moduleAt("modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts");
const geometryColors = await moduleAt("modules/viewport-3d/viewport3dGeometryColors.ts");
const viewport = source("modules/viewport-3d/Viewport3DModule.tsx", ts.ScriptKind.TSX);
const legendNames = ["resolveSavedFieldColorbars", "resolveViewport3DColorbarLegend", "formatViewport3DColorbarQuantityLabel"];
const legendDeclarations = viewport.statements.filter(node => ts.isFunctionDeclaration(node) && legendNames.includes(node.name?.text));
assert.equal(legendDeclarations.length, 3);
const legendContext = execute(legendDeclarations.map(node => node.getText(viewport)).join("\n"), {
  normalizeDisplayUnit: units.normalizeDisplayUnit, formatValueWithDisplayUnit: units.formatValueWithDisplayUnit,
  viewport3DColorPaletteGradientCss: coloring.viewport3DColorPaletteGradientCss,
});
const scopeKey = "project:p/run:r/revision:1/member:m/manifest:owned/sample:s/field:H/dataset:1";
const scale = { quantityId: "H_ant", colorMode: "x", colorPalette: "inferno", range: { min: 0, max: 2 } };
const settings = { visible: true, viewportColorbarVisible: true, shaderVisible: false, surfaceColorSource: "component_x", vectorsVisible: true, vectorColorMode: "x", scalarColorPalette: "inferno" };
function legends(scales, config = settings, unit = "A/m", quantityId = "H_ant", requestedScope = scopeKey) {
  legendContext.input = { scales, scopeKey: requestedScope, settings: config, quantityId, unit };
  return vm.runInContext("resolveSavedFieldColorbars(input)", legendContext);
}
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
check("scope and owner cleanup fences preserve the current immutable result", () => {
  let state = { scopeKey, passes: {} };
  assert.equal(legends(state).length, 0, "No legend may precede its first adoption");
  assert.strictEqual(visible.updateVisibleColorScales(state, { scopeKey: "foreign", pass: "vectors", ownerId: "old", scale }), state);
  state = visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "old", scale });
  const incoming = { ...scale, range: { min: 0, max: 4 } };
  state = visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "new", scale: incoming });
  incoming.range.max = 99;
  assert.equal(state.passes.vectors.scale.range.max, 4, "Report metadata must be owned");
  assert.strictEqual(visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "old", scale: null, removed: true }), state);
  const same = visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "new", scale: state.passes.vectors.scale });
  assert.strictEqual(same, state, "Replayed identical adoption must not rerender");
  assert.equal(legends(state, settings, "A/m", "H_ant", "foreign").length, 0);
  assert.equal(legends({ scopeKey: "foreign", passes: {} }).length, 0);
  const cleared = visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "new", scale: null, removed: true });
  assert.equal(legends(cleared).length, 0);
});
check("real buffers expose only valid numerical scale metadata", () => {
  const field = { nComp: 3, pointCount: 3, quantityId: "H_ant", values: Float64Array.from([0,0,0, 1,0,0, 2,0,0]) };
  const buffer = mapping.buildVertexScalarColors(field, 3, Infinity, "x", "inferno", { min: 0, max: 2 });
  const report = visible.visibleColorScaleFromBuffer(buffer);
  assert.deepEqual({ ...report.range }, { min: 0, max: 2 }); assert.equal(report.quantityId, "H_ant");
  report.range.max = 9; assert.equal(buffer.range.max, 2);
  for (const colorMode of ["orientation", "monochrome"]) assert.equal(visible.visibleColorScaleFromBuffer({ ...buffer, colorMode }), null);
  for (const range of [{ min: NaN, max: 2 }, { min: 0, max: Infinity }, { min: 2, max: 1 }]) assert.equal(visible.visibleColorScaleFromBuffer({ ...buffer, range }), null);
  assert.equal(visible.visibleColorScaleFromBuffer(null), null);
});
check("legend uses adopted palette component and range rather than requested settings", () => {
  let state = visible.updateVisibleColorScales({ scopeKey, passes: {} }, { scopeKey, pass: "vectors", ownerId: "v", scale });
  const requested = { ...settings, vectorColorMode: "y", scalarColorPalette: "coolwarm" };
  let result = legends(state, requested);
  assert.equal(result[0].legend.colorMode, "x"); assert.equal(result[0].legend.range.max, 2);
  assert.equal(result[0].legend.paletteGradient, coloring.viewport3DColorPaletteGradientCss("inferno"));
  assert.equal(legends(state, requested, "V", "V_electric").length, 0, "Unrelated quantity/unit cannot reuse a field scale");
  state = visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "v", scale: null });
  assert.equal(legends(state, requested).length, 0, "Orientation/monochrome adoption clears numerical legend");
});

const scheduler = source("modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts");
const client = scheduler.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "VectorGlyphWorkerClient");
const buildMethod = client.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(scheduler) === "build");
const statements = buildMethod.body.statements;
const start = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(scheduler) === "segments"));
const end = statements.findIndex(ts.isReturnStatement);
const transferHelper = scheduler.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "addArrayBufferTransferable");
check("production worker envelope transfers scale with owned RGB and geometry result", () => {
  const input = { segments: Float32Array.from([0,0,0, 0,1,0, 1]), colorsOverride: Float32Array.from([.75,.25,.5]), colorScale: scale, colorMode: "x" };
  const context = execute(`${transferHelper.getText(scheduler)}\n${statements.slice(start, end).map(node => node.getText(scheduler)).join("\n")}\nglobalThis.envelope = {request, transferables};`,
    { input, id: 41, Float32Array, ArrayBuffer });
  const received = structuredClone(context.envelope.request, { transfer: context.envelope.transferables });
  assert.equal(input.segments.byteLength, 28); assert.equal(input.colorsOverride.byteLength, 12);
  assert.notStrictEqual(received.colorScale.range, input.colorScale.range);
  const worker = source("modules/viewport-3d/layers/vectorGlyphBuildWorker.ts");
  const workerCode = worker.statements.filter(node => ts.isFunctionDeclaration(node) || ts.isExpressionStatement(node) && node.expression.getText(worker).startsWith("workerScope.addEventListener(")).map(node => node.getText(worker)).join("\n");
  let handler, response;
  execute(workerCode, { buildViewport3DVectorGlyphs: glyphs.buildViewport3DVectorGlyphs,
    transferablesForVectorGlyphBuildResult: glyphs.transferablesForVectorGlyphBuildResult,
    workerScope: { addEventListener: (_, callback) => { handler = callback; }, postMessage: (message, transfers = []) => { response = structuredClone(message, { transfer: transfers }); } } });
  handler({ data: received }); assert.equal(response.ok, true);
  assert.deepEqual(response.data.colorScale, input.colorScale);
  assert.deepEqual([...response.data.colors], [...input.colorsOverride]);
  received.colorScale.range.max = 99; assert.equal(response.data.colorScale.range.max, 2);
});

const layer = source("modules/viewport-3d/layers/VectorFieldLayer.tsx", ts.ScriptKind.TSX);
const component = layer.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "VectorFieldLayer");
const recordDeclaration = component.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(layer) === "recordAdoption"));
function recordAdoption(result, publish) {
  const context = execute(`${recordDeclaration.getText(layer)}\nglobalThis.adopt = recordAdoption;`, {
    useCallback: callback => callback, colorScopeKey: scopeKey, adoptionOwnerId: "actual-vector-layer",
    onVisibleColorScale: publish, glyphBuild: result, glyphCount: result.transforms.count,
    resolveVectorFieldAdoptionBuildKey: () => null, adoptionRegistry: null, carrierId: null, fieldBufferId: null, sessionIdentity: null,
  });
  return context.adopt;
}
check("semantic glyph cache keys include the actual scale and preserve identical copied metadata", () => {
  const names = ["glyphColorBufferKey", "createVectorGlyphSemanticBuildKey"];
  const keyCode = layer.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ["glyphColorBufferKeys", "nextGlyphColorBufferKey"].includes(d.name.getText(layer)))).map(node => node.getText(layer)).join("\n");
  const context = execute(keyCode);
  const args = { buildReference: { buildKey: scopeKey }, colorMode: "x", colorScale: scale,
    colorsOverride: new Float32Array([.5,.5,.5]), headRadiusRatio: .1, shaftRadiusRatio: .03 };
  const key = patch => { context.args = { ...args, ...patch }; return vm.runInContext("createVectorGlyphSemanticBuildKey(args)", context); };
  const first = key({});
  assert.equal(key({ colorScale: { ...scale, range: { ...scale.range } } }), first);
  assert.notEqual(key({ colorScale: { ...scale, range: { min: 0, max: 4 } } }), first);
  assert.notEqual(key({ buildReference: { buildKey: "another-immutable-field" } }), first);
  assert.equal(key({}), first);
});
check("clipping and shader coordinates use the same physical scale without modifying data", () => {
  const values = Float64Array.from([-3,0,0, .5,0,0, 3,0,0]), before = [...values];
  const buffer = mapping.buildVertexScalarColors({ nComp: 3, pointCount: 3, quantityId: "H_ant", values }, 3, Infinity, "x", "inferno", { min: 0, max: 1 });
  assert.deepEqual([...buffer.scalarValues], [0,.5,1]);
  for (const [node, t] of [[0,0], [1,.5], [2,1]]) {
    const expected = coloring.resolveViewport3DVectorColorRgb("x", t, 0, 0, { min: 0, max: 1 }, 1, "inferno");
    assert.deepEqual([...buffer.colors.subarray(node * 3, node * 3 + 3)], Array.from(expected, Math.fround));
  }
  assert.deepEqual([...values], before);
  assert.deepEqual({ ...visible.visibleColorScaleFromBuffer(buffer).range }, { min: 0, max: 1 });
});
check("actual vector lifecycle clears no-glyph output and fences stale-owner cleanup", () => {
  const declarations = component.body.statements.filter(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(layer) === "useEffect" &&
    node.getText(layer).includes('pass: "vectors"'));
  assert.equal(declarations.length, 2, "Use both actual vector report cleanup effects");
  let state = visible.updateVisibleColorScales({ scopeKey, passes: {} }, { scopeKey, pass: "vectors", ownerId: "old-owner", scale });
  function lifecycle(glyphBuild, glyphCount) {
    const effects = [];
    execute(declarations.map(node => node.getText(layer)).join("\n"), {
      useEffect: callback => effects.push(callback), glyphBuild, glyphCount, colorScopeKey: scopeKey,
      adoptionOwnerId: "old-owner", onVisibleColorScale: report => { state = visible.updateVisibleColorScales(state, report); },
    });
    return effects.map(callback => callback());
  }
  lifecycle(null, 0);
  assert.equal(legends(state).length, 0);
  state = visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "old-owner", scale });
  const cleanups = lifecycle({ colorScale: scale }, 1);
  state = visible.updateVisibleColorScales(state, { scopeKey, pass: "vectors", ownerId: "new-owner", scale });
  const before = state;
  cleanups.forEach(cleanup => cleanup?.());
  assert.strictEqual(state, before, "Old layer unmount cannot clear the new layer's adopted scale");
  for (const colorMode of ["orientation", "monochrome"]) {
    const result = glyphs.buildViewport3DVectorGlyphs({ segments: Float32Array.from([0,0,0, 0,1,0, 1]), colorMode, colorScale: null });
    recordAdoption(result, report => { state = visible.updateVisibleColorScales(state, report); })(0);
    assert.equal(legends(state).length, 0);
  }
});
const uploadNames = ["useVectorGlyphUpload", "buildVectorGlyphUploadBatches", "markVectorGlyphAttributeRange",
  "createVectorGlyphColorUploadRollback", "createVectorGlyphMatrixUploadRollback", "restoreVectorGlyphUpdateRanges",
  "syncVectorGlyphColorState", "estimateVectorGlyphTransformBytes", "createVectorGlyphUploadKeys"];
const uploadConstants = ["UNIT_Y", "VECTOR_GLYPH_UPLOAD_BATCH_SIZE", "VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS", "VECTOR_GLYPH_COLOR_UPLOAD_MEASURE", "VECTOR_GLYPH_MATRIX_UPLOAD_MEASURE"];
const code = ts.transpileModule(layer.statements.filter(node => ts.isFunctionDeclaration(node) && uploadNames.includes(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d => uploadConstants.includes(d.name.getText(layer)))).map(node => node.getText(layer)).join("\n").replace(/^export /gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
// Reuse the deterministic production-hook/real-manager fixture, not a fake upload.
const fixtureFile = fileURLToPath(new URL("./check-vector-glyph-atomic-upload.mjs", import.meta.url));
const fixtureSource = ts.createSourceFile(fixtureFile, readFileSync(fixtureFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const fixtureCode = fixtureSource.statements.filter(node => ts.isFunctionDeclaration(node) && ["fixture", "transforms"].includes(node.name?.text)).map(node => node.getText(fixtureSource)).join("\n");
const fixtureContext = execute(fixtureCode, { assert, Three, gpu, vm, code, AbortController, count: 257 });
check("actual upload callback retains old legend until atomic RGB/matrix adoption", () => {
  const f = vm.runInContext("fixture()", fixtureContext);
  let state = { scopeKey, passes: {} };
  const publish = report => { state = visible.updateVisibleColorScales(state, report); };
  const oldResult = { transforms: f.base.glyphTransforms, colorScale: scale };
  const nextScale = { ...scale, range: { min: 0, max: 4 } };
  const nextResult = { transforms: f.base.glyphTransforms, colorScale: nextScale };
  const callbacks = new Map([["old-to-new", recordAdoption(oldResult, publish)], ["replacement", recordAdoption(nextResult, publish)]]);
  f.adoptions.push = (...receipts) => { for (const receipt of receipts) callbacks.get(receipt.key)(receipt.bytes); return Array.prototype.push.apply(f.adoptions, receipts); };
  try {
    f.render(); assert.equal(legends(state).length, 0); f.frame(); assert.equal(legends(state).length, 0); f.drain();
    assert.equal(legends(state)[0].legend.range.max, 2);
    f.render({ buildKey: "replacement", glyphColors: new Float32Array(257 * 3).fill(.375) });
    f.frame(); assert.equal(legends(state)[0].legend.range.max, 2, "Pending GPU batch must retain the adopted old scale");
    f.drain(); assert.equal(legends(state)[0].legend.range.max, 4);
    assert.deepEqual(Array.from(f.adoptions, item => item.key), ["old-to-new", "replacement"]);
  } finally { f.dispose(); }
});

const fallback = source("modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx", ts.ScriptKind.TSX);
const fallbackFunction = fallback.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "FallbackTopologyMeshLayer");
const surfaceStatements = fallbackFunction.body.statements;
const surfaceStart = surfaceStatements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
  ts.isArrayBindingPattern(d.name) && d.name.elements.some(element => element.name?.getText(fallback) === "surfaceChoice")));
const surfaceEnd = surfaceStatements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(fallback) === "renderPlan"));
assert.ok(surfaceStart >= 0 && surfaceEnd > surfaceStart);
const surfaceCode = surfaceStatements.slice(surfaceStart, surfaceEnd).map(node => node.getText(fallback)).join("\n") +
  "\nglobalThis.result = { confirmedChoice, retainedSurfaceBuffer, shaderSurfaceBuffer, vertexSurfaceBuffer, hasScalarColors };";
check("actual tiny-state surface choice retains confirmed stores and fences scope/geometry/source changes", () => {
  const field = { nComp: 3, pointCount: 3, quantityId: "H_ant", values: Float64Array.from([0,0,0, 1,0,0, 2,0,0]) };
  const oldBuffer = mapping.buildVertexScalarColors(field, 3, Infinity, "x", "inferno", { min: 0, max: 2 });
  const newBuffer = mapping.buildVertexScalarColors(field, 3, Infinity, "x", "coolwarm", { min: -4, max: 4 });
  const thirdBuffer = mapping.buildVertexScalarColors(field, 3, Infinity, "x", "inferno", { min: 0, max: 8 });
  let choice = { scopeKey: null, shader: false, bufferKey: null }, stateWrites = 0;
  let vertexUpload = { fresh: false, buffer: null }, shaderUpload = { fresh: false, buffer: null };
  const geometry = new Three.BufferGeometry();
  const unavailable = () => ({ fresh: false, buffer: null });
  function choose(patch = {}) {
    if (patch.vertexUpload) vertexUpload = patch.vertexUpload;
    if (patch.shaderUpload) shaderUpload = patch.shaderUpload;
    const result = execute(surfaceCode, {
      useState: () => [choice, next => { choice = next; stateWrites++; }],
      selectVisibleSurfaceChoice: visible.selectVisibleSurfaceChoice,
      resolveViewport3DScalarColorBufferKey: mapping.resolveViewport3DScalarColorBufferKey,
      vertexColorsEnabled: true, colorScopeKey: scopeKey, topologyModel: { nodeCount: 3 },
      shaderScalarColorsEnabled: false, visibleScalarColorsUpload: vertexUpload,
      visibleShaderScalarColorsUpload: shaderUpload, visibleScalarColors: vertexUpload.buffer,
      visibleShaderScalarColors: shaderUpload.buffer, effectiveScalarColors: newBuffer,
      canUseVertexScalarColors: true, canApplyVertexScalarColorBuffer: geometryColors.canApplyVertexScalarColorBuffer,
      geometry, ...patch,
    }).result;
    assert.deepEqual(Object.keys(choice).sort(), ["bufferKey", "scopeKey", "shader"]);
    assert.equal(typeof choice.shader, "boolean");
    assert.ok(choice.scopeKey === null || typeof choice.scopeKey === "string");
    assert.ok(choice.bufferKey === null || typeof choice.bufferKey === "string", "React state must contain only tiny metadata, never buffers or geometry");
    return result;
  }
  assert.equal(choose().retainedSurfaceBuffer, null);
  assert.strictEqual(choose({ vertexUpload: { fresh: true, buffer: oldBuffer }, effectiveScalarColors: oldBuffer }).vertexSurfaceBuffer, oldBuffer);
  const adoptedChoice = choice, writes = stateWrites;
  assert.strictEqual(choose().vertexSurfaceBuffer, oldBuffer, "Pending new upload must retain the adopted old surface");
  assert.strictEqual(choice, adoptedChoice); assert.equal(stateWrites, writes, "Unchanged retained choice must not enqueue render updates");
  const next = choose({ vertexUpload: { fresh: true, buffer: newBuffer } });
  assert.strictEqual(next.vertexSurfaceBuffer, newBuffer);
  assert.equal(visible.visibleColorScaleFromBuffer(next.vertexSurfaceBuffer).range.max, 4);
  // Actual upload hooks return null when their geometry or retention scope changes.
  assert.equal(choose({ geometry: new Three.BufferGeometry(), vertexUpload: unavailable(), shaderUpload: unavailable() }).retainedSurfaceBuffer, null);
  choose({ vertexUpload: { fresh: true, buffer: oldBuffer }, effectiveScalarColors: oldBuffer });
  assert.equal(choose({ colorScopeKey: "another-immutable-result", vertexUpload: unavailable(), shaderUpload: unavailable() }).retainedSurfaceBuffer, null);
  assert.equal(choice.scopeKey, "another-immutable-result"); assert.equal(choice.bufferKey, null);
  choose({ vertexUpload: { fresh: true, buffer: oldBuffer }, effectiveScalarColors: oldBuffer });
  assert.equal(choose({ vertexColorsEnabled: false }).retainedSurfaceBuffer, null, "Solid source must clear numerical scale");
  assert.equal(choice.bufferKey, null);
  const disabledChoice = choice;
  choose({ vertexColorsEnabled: false }); assert.strictEqual(choice, disabledChoice);
  choose({ shaderScalarColorsEnabled: true, shaderUpload: { fresh: true, buffer: oldBuffer }, effectiveScalarColors: oldBuffer });
  choose({ vertexUpload: { fresh: true, buffer: newBuffer }, effectiveScalarColors: newBuffer });
  const pendingShader = choose({ shaderScalarColorsEnabled: true,
    shaderUpload: { fresh: true, buffer: oldBuffer }, effectiveScalarColors: thirdBuffer });
  assert.strictEqual(pendingShader.vertexSurfaceBuffer, newBuffer,
    "A historical fresh shader snapshot must not replace the last visible vertex buffer while a new shader upload is pending");
  const adoptedShader = choose({ shaderScalarColorsEnabled: true,
    shaderUpload: { fresh: true, buffer: thirdBuffer }, effectiveScalarColors: thirdBuffer });
  assert.strictEqual(adoptedShader.shaderSurfaceBuffer, thirdBuffer);
  geometry.dispose();
});
console.log(JSON.stringify({ status: "passed", checks, scope: "production metadata/reducer/worker/upload callback/surface retention source declarations",
  browser_verified: false, gpu_draw_verified: false, unit_test_compilation: false }));
