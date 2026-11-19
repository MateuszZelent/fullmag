import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const root = fileURLToPath(new URL("../src/", import.meta.url));
const cache = new Map();
let buildOptions;
const stubs = new Map();
function synthetic(key, values) {
  if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }));
  return cache.get(key);
}
async function moduleAt(file) {
  if (cache.has(file)) return cache.get(file);
  const output = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const mod = new vm.SourceTextModule(output, { identifier: file });
  cache.set(file, mod);
  await mod.link(async spec => {
    if (stubs.has(spec)) return synthetic(spec, stubs.get(spec));
    if (!spec.startsWith(".") && !spec.startsWith("@/")) return synthetic(spec, require(spec));
    let target = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(file), spec);
    target = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find(existsSync);
    assert.ok(target, `Unresolved ${spec} from ${file}`);
    return moduleAt(target);
  });
  return mod;
}
const controllerModule = await moduleAt(path.join(root, "kernel/visualization/ObjectVisualizationController.ts"));
await controllerModule.evaluate();
const { ObjectVisualizationController } = controllerModule.namespace;
const selectionModule = await moduleAt(path.join(root, "kernel/selection/selectionTypes.ts"));
await selectionModule.evaluate();
const { pinnedMaterializedDatasetSelectionRef } = selectionModule.namespace;
const presentationModule = await moduleAt(path.join(root, "kernel/visualization/savedFieldPresentation.ts"));
await presentationModule.evaluate();
const { returnToCurrentFieldView } = presentationModule.namespace;
const ref = pinnedMaterializedDatasetSelectionRef({ projectId: "project", runId: "run", solutionSetId: "solution",
  containingRevision: "1", memberId: "member", artifactId: "artifact", manifestObjectRef: "manifest",
  sampleId: "sample", itemId: "item", fieldId: "field", datasetId: "dataset", datasetRevision: "1" });
const controller = new ObjectVisualizationController();
controller.setSavedFieldPresentation(ref, "H_ant", "3");
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.vectorsVisible, true);
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.shaderVisible, false);
controller.patchSavedFieldPresentation(ref, { shaderColorMode: "x", scalarColorPalette: "inferno", vectorBudget: 7,
  vectorsVisible: true, surfaceOpacityPercent: 37, vectorLengthScale: 2 });
let presentation = controller.getSnapshot().savedFieldPresentation;
assert.equal(presentation.settings.surfaceColorSource, "component_x");
assert.equal(presentation.settings.scalarColorPalette, "inferno");
assert.equal(presentation.settings.vectorBudget, 7);
assert.equal(presentation.settings.surfaceOpacityPercent, 37);
assert.deepEqual(controller.getSnapshot().overrides, {}, "Saved appearance must not modify live target overrides");
const same = controller.getSnapshot();
controller.setSavedFieldPresentation({ ...ref }, "H_ant", "3");
assert.equal(controller.getSnapshot(), same, "Same result must preserve settings and snapshot identity");
controller.patchSavedFieldPresentation({ ...ref, manifestObjectRef: "foreign" }, { vectorsVisible: false });
assert.equal(controller.getSnapshot(), same, "Stale inspector cannot mutate another saved result");
controller.patchSavedFieldPresentation(ref, { activeQuantityId: "m", geometryScope: "surface", surfaceProjectionMode: "thickness_average_z" });
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.activeQuantityId, "H_ant");
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.geometryScope, "full");
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.surfaceProjectionMode, "raw_nodal");
controller.setSavedFieldPresentation({ ...ref, manifestObjectRef: "new-manifest" }, "V_electric", "1");
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.vectorsVisible, false);
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.shaderColorMode, "magnitude");
controller.clearSavedFieldPresentation();
assert.equal(controller.getSnapshot().savedFieldPresentation, null);
console.log("PASS immutable result identity, stale edits, local settings and explicit exit");
const selectionControllerModule = await moduleAt(path.join(root, "kernel/selection/SelectionController.ts"));
await selectionControllerModule.evaluate();
const guardedSelection = new selectionControllerModule.namespace.SelectionController({ emit: () => {} });
const guardedPresentation = new ObjectVisualizationController();
const browserFile = path.join(root, "modules/results-navigator/SavedResultsBrowser.tsx");
const browserSource = ts.createSourceFile(browserFile, readFileSync(browserFile, "utf8"), ts.ScriptTarget.Latest, true);
let inspectDeclaration;
function findInspect(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(browserSource) === "inspectSelected") inspectDeclaration = node.getText(browserSource);
  ts.forEachChild(node, findInspect);
}
findInspect(browserSource);
assert.ok(inspectDeclaration);
const metadata = { data: { artifact_id: ref.artifactId, containing_solution_revision: ref.containingRevision,
  dataset: { dataset_id: ref.datasetId, revision: ref.datasetRevision }, field_id: ref.fieldId,
  item_id: ref.itemId, manifest_object_ref: ref.manifestObjectRef, member_id: ref.memberId,
  project_id: ref.projectId, run_id: ref.runId, sample_id: ref.sampleId, solution_set_id: ref.solutionSetId,
  field: { descriptor: { quantity_id: "H_ant" }, coverage: { component_count: "3" } } } };
const actionContext = vm.createContext({ metadata, canInspect: true, selectedArtifact: {},
  materializedDatasetMatchesArtifact: () => true, pinnedMaterializedDatasetSelectionRef,
  selectionRefEquals: selectionModule.namespace.selectionRefEquals,
  kernel: { selection: guardedSelection, visualization: guardedPresentation }, moduleId: "results-navigator" });
vm.runInContext(ts.transpileModule(`const ${inspectDeclaration}; inspectSelected();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, actionContext);
assert.equal(guardedPresentation.getSnapshot().savedFieldPresentation.selection.nodeId, ref.nodeId);
guardedPresentation.clearSavedFieldPresentation();
guardedSelection.clear("results-navigator");
guardedSelection.addChangeGuard(() => false);
vm.runInContext("inspectSelected();", actionContext);
assert.equal(guardedPresentation.getSnapshot().savedFieldPresentation, null, "Rejected selection must not arm saved rendering");
guardedPresentation.setSavedFieldPresentation(ref, "H_ant", "3");
const refusedClear = { get: () => ({ ref }), clear: () => {} };
const beforeRefusedClear = guardedPresentation.getSnapshot();
assert.equal(returnToCurrentFieldView(guardedPresentation, refusedClear, "viewport-3d"), false);
assert.equal(guardedPresentation.getSnapshot(), beforeRefusedClear);
console.log("PASS Results inspection and Current view respect real selection guards");


stubs.set("./viewport3dRenderModel", {
  FULL_VIEWPORT_3D_TARGET_ID: "full",
  resolveTopologyBounds: () => ({ center: [0, 0, 0], size: [1, 1, 1] }),
  buildViewport3DTopologyRenderModel: () => ({}),
  buildViewport3DFieldRenderModel: (_topology, _values, _scale, options) => {
    buildOptions = options;
    return { scalarColors: null, scalarColorsByMode: new Map(), scalarColorsByPartAndMode: new Map(), targetPasses: new Map() };
  },
});
const adapter = await moduleAt(path.join(root, "modules/viewport-3d/savedFieldViewportAdapter.ts"));
await adapter.evaluate();
const geometry = { representation_evidence: "not_verified", geometry_manifest: { object_ref: "mesh" }, topology_fingerprint: "topology", owner_solution_revision: "1" };
const topology = { nodeCount: 4, positions: new Float64Array(12), cellCount: 1, elementCount: 1, boundaryFaceCount: 4 };
const field = { representationEvidence: "not_verified", nodeCount: 4, componentCount: 3, dtype: "f64", quantityId: "H_ant",
  values: new Float64Array(12), savedScopeKey: "saved-key", topologyFingerprint: "topology" };
const support = { nodeCount: 4, bits: new Uint8Array([5]) };
const model = adapter.namespace.buildSavedFieldViewportSceneModel({ geometry, topology, field, support,
  palette: "inferno", vectorColorMode: "z", vectorScale: 1, settings: presentation.settings, sceneVectorCap: 1 });
assert.ok(model);
assert.equal(model.carrier.role, "saved-domain");
assert.equal(model.carrier.object_id, null);
assert.equal(model.femDomain.airboxParts.length, 0);
assert.equal(model.femDomain.magneticParts.length, 0);
assert.equal(buildOptions.fullScalarColorMode, "x");
assert.equal(buildOptions.fullScalarColorPalette, "inferno");
assert.equal(buildOptions.fullVectorBudget, 1);
assert.deepEqual([...buildOptions.scalarColorModes], ["x"]);
assert.equal(buildOptions.vectorColorMode, "z");
assert.ok(adapter.namespace.buildSavedFieldViewportSceneModel({ geometry, topology, field, support,
  palette: "inferno", vectorColorMode: "z", vectorScale: 1, settings: presentation.settings, sceneVectorCap: 2048 }));
assert.equal(buildOptions.fullVectorBudget, 2, "Arrow count must not exceed active support");
const sceneFile = path.join(root, "modules/viewport-3d/hooks/useViewport3DSceneModel.ts");
const sceneSource = ts.createSourceFile(sceneFile, readFileSync(sceneFile, "utf8"), ts.ScriptTarget.Latest, true);
let budgetExpression;
function findBudget(node) {
  if (ts.isCallExpression(node) && node.expression.getText(sceneSource) === "resolveViewport3DVectorScale" &&
      node.arguments[0]?.getText(sceneSource).startsWith("bounds?.size")) budgetExpression = node.arguments[2].getText(sceneSource);
  ts.forEachChild(node, findBudget);
}
findBudget(sceneSource);
assert.ok(budgetExpression);
const scaleBudget = new vm.Script(budgetExpression).runInNewContext({
  savedPresentation: { settings: { vectorBudget: 1200 } }, maxInteractiveVectorGlyphs: 2048,
  savedViewportResources: { geometry: { data: { active_node_count: "14" } } },
});
assert.equal(scaleBudget, 14, "Sparse-field arrow length must use effective density");
const scalar = { ...field, componentCount: 1, quantityId: "V_electric", values: new Float64Array(4) };
assert.ok(adapter.namespace.buildSavedFieldViewportSceneModel({ geometry, topology, field: scalar, support,
  palette: "inferno", vectorColorMode: "z", vectorScale: 1, settings: presentation.settings }));
assert.equal(buildOptions.fullVectorBudget, 0);
assert.equal(buildOptions.fullScalarColorMode, "magnitude");
console.log("PASS saved carrier ownership, component/palette wiring, bounded arrows and scalar exclusion");
const antennaHookFile = path.join(root, "modules/viewport-3d/hooks/useAntennaFieldOverlay.ts");
const antennaHookSource = ts.createSourceFile(antennaHookFile, readFileSync(antennaHookFile, "utf8"), ts.ScriptTarget.Latest, true);
let intentExpression;
function findIntent(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(antennaHookSource) === "displayIntent") intentExpression = node.initializer.getText(antennaHookSource);
  ts.forEachChild(node, findIntent);
}
findIntent(antennaHookSource);
const owner = { sessionId: "s", sessionEpoch: 1, requestScopeEpoch: 1 };
const requested = { ...owner, sourceObjectId: "antenna", vectors: true };
const displayIntent = new vm.Script(intentExpression);
assert.equal(displayIntent.runInNewContext({ enabled: false, requested, owner, selectedObjectId: "antenna" }), null);
assert.ok(displayIntent.runInNewContext({ enabled: true, requested, owner, selectedObjectId: "antenna" }));
console.log("PASS saved presentation suppresses current-session antenna overlay admission");

// Load the production metadata gate without mounting a second resource owner.
const gateFile = path.join(root, "kernel/resources/savedFieldViewportResources.ts");
const gateSource = ts.createSourceFile(gateFile, readFileSync(gateFile, "utf8"), ts.ScriptTarget.Latest, true);
const gateFunctions = ["counter", "safeCount", "unavailable", "resolveSavedFieldViewportMetadataEligibility"];
const gateConstants = ["SAVED_VIEWPORT_FIELD_MAX_BYTES", "SAVED_VIEWPORT_FIELD_MAX_CHUNKS", "MAX_U64", "ZERO"];
const gateCode = gateSource.statements.filter(node =>
  ts.isFunctionDeclaration(node) && gateFunctions.includes(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => gateConstants.includes(declaration.name.getText(gateSource)))
).map(node => node.getText(gateSource)).join("\n");
const sliceCodec = await moduleAt(path.join(root, "kernel/api/codecs/materializedDatasetSliceCodec.ts"));
await sliceCodec.evaluate();
const gateBindings = { MAX_DATASET_SLICE_BYTES: sliceCodec.namespace.MAX_DATASET_SLICE_BYTES,
  materializedDatasetSliceByteLimit: sliceCodec.namespace.materializedDatasetSliceByteLimit };
const gate = new vm.SourceTextModule(ts.transpileModule(`import { ${Object.keys(gateBindings).join(",")} } from "gate-bindings";\n${gateCode}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText);
await gate.link(() => synthetic("gate-bindings", gateBindings));
await gate.evaluate();
const { resolveSavedFieldViewportMetadataEligibility } = gate.namespace;

// Unlike the budget wiring check above, this path uses the real render model.
stubs.delete("./viewport3dRenderModel");
cache.delete(path.join(root, "modules/viewport-3d/savedFieldViewportAdapter.ts"));
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

const glyphModelModule = await moduleAt(path.join(root, "modules/viewport-3d/layers/vectorGlyphBuildModel.ts"));
await glyphModelModule.evaluate();
const buildGlyphs = glyphModelModule.namespace.buildViewport3DVectorGlyphs;
const oldRgb = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
const oldGlyphs = buildGlyphs({ segments: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1]), colorsOverride: oldRgb });
const newGlyphs = buildGlyphs({ segments: new Float32Array([5, 0, 0, 5, 0, 1, 1]), colorsOverride: new Float32Array([0.9, 0.8, 0.7]) });
assert.equal(oldGlyphs.transforms.count, 2);
assert.equal(oldGlyphs.colors.length, 6);
assert.equal(newGlyphs.transforms.count, 1);
assert.equal(newGlyphs.colors.length, 3);
assert.notEqual(oldGlyphs.colors.buffer, oldRgb.buffer, "Transferred output must own its colors");
assert.deepEqual([...oldGlyphs.colors], [...oldRgb], "Building the next frame must preserve the retained frame's physical colors");
assert.throws(() => buildGlyphs({ segments: new Float32Array([0, 0, 0, 1, 0, 0, 1]), colorsOverride: oldRgb }),
  /colors do not match/, "Misaligned colors must be rejected before upload");
const glyphLayerFile = path.join(root, "modules/viewport-3d/layers/VectorFieldLayer.tsx");
const glyphLayerSource = ts.createSourceFile(glyphLayerFile, readFileSync(glyphLayerFile, "utf8"), ts.ScriptTarget.Latest, true);
const keyNames = ["glyphColorBufferKey", "createVectorGlyphSemanticBuildKey"];
const keyCode = glyphLayerSource.statements.filter(node =>
  ts.isFunctionDeclaration(node) && keyNames.includes(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ["glyphColorBufferKeys", "nextGlyphColorBufferKey"].includes(d.name.getText(glyphLayerSource)))
).map(node => node.getText(glyphLayerSource)).join("\n");
const keyContext = vm.createContext({ WeakMap });
vm.runInContext(ts.transpileModule(keyCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, keyContext);
keyContext.args = { buildReference: { buildKey: "same-field-and-topology" }, colorMode: "x", headRadiusRatio: 0.1, shaftRadiusRatio: 0.03, colorsOverride: oldRgb };
const keyBefore = vm.runInContext("createVectorGlyphSemanticBuildKey(args)", keyContext);
assert.equal(vm.runInContext("createVectorGlyphSemanticBuildKey(args)", keyContext), keyBefore);
keyContext.args = { ...keyContext.args, colorsOverride: new Float32Array(oldRgb) };
assert.notEqual(vm.runInContext("createVectorGlyphSemanticBuildKey(args)", keyContext), keyBefore,
  "Different immutable RGB inputs must not reuse a transform/color cache entry");
const glyphLayerDeclaration = glyphLayerSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "VectorFieldLayer");
let colorsInitializer;
function findVisibleColors(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(glyphLayerSource) === "glyphColors") colorsInitializer = node.initializer.getText(glyphLayerSource);
  ts.forEachChild(node, findVisibleColors);
}
findVisibleColors(glyphLayerDeclaration);
assert.equal(colorsInitializer, "glyphBuild?.colors ?? null", "Visible colors must come from the same retained result as the transforms");
console.log("PASS atomic glyph transform/color result, mismatched counts, input ownership and cache identity");

// Exercise the production request envelope and worker callback with real buffer transfer.
const schedulerFile = path.join(root, "modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts");
const schedulerSource = ts.createSourceFile(schedulerFile, readFileSync(schedulerFile, "utf8"), ts.ScriptTarget.Latest, true);
const clientClass = schedulerSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "VectorGlyphWorkerClient");
const clientBuild = clientClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(schedulerSource) === "build");
const envelopeStatements = clientBuild.body.statements;
const envelopeStart = envelopeStatements.findIndex(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(d => d.name.getText(schedulerSource) === "segments"));
const envelopeEnd = envelopeStatements.findIndex(node => ts.isReturnStatement(node));
assert.ok(envelopeStart >= 0 && envelopeEnd > envelopeStart);
const envelopeCode = envelopeStatements.slice(envelopeStart, envelopeEnd).map(node => node.getText(schedulerSource)).join("\n");
const transferHelper = schedulerSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "addArrayBufferTransferable");
const transferInput = { segments: new Float32Array([0, 0, 0, 1, 0, 0, 1]), colorsOverride: new Float32Array([0.2, 0.4, 0.6]) };
const transferContext = vm.createContext({ input: transferInput, id: 19, Float32Array, ArrayBuffer, structuredClone,
  buildViewport3DVectorGlyphs: buildGlyphs,
  transferablesForVectorGlyphBuildResult: glyphModelModule.namespace.transferablesForVectorGlyphBuildResult });
vm.runInContext(ts.transpileModule(`${transferHelper.getText(schedulerSource)}\n${envelopeCode}\nglobalThis.envelope = {request, transferables};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, transferContext);
const envelope = transferContext.envelope;
const received = structuredClone(envelope.request, { transfer: envelope.transferables });
assert.equal(envelope.request.segments.byteLength, 0, "Worker request must transfer its owned segment copy");
assert.equal(envelope.request.colorsOverride.byteLength, 0, "Worker request must transfer its owned RGB copy");
assert.equal(transferInput.segments.byteLength, 28, "Sending the request must preserve renderer segments");
assert.equal(transferInput.colorsOverride.byteLength, 12, "Sending the request must preserve renderer RGB");
const workerFile = path.join(root, "modules/viewport-3d/layers/vectorGlyphBuildWorker.ts");
const workerSource = ts.createSourceFile(workerFile, readFileSync(workerFile, "utf8"), ts.ScriptTarget.Latest, true);
const workerCode = workerSource.statements.filter(node => ts.isFunctionDeclaration(node) ||
  ts.isExpressionStatement(node) && node.expression.getText(workerSource).startsWith("workerScope.addEventListener(")
).map(node => node.getText(workerSource)).join("\n");
let workerHandler, workerResponse;
transferContext.workerScope = {
  addEventListener: (type, handler) => { assert.equal(type, "message"); workerHandler = handler; },
  postMessage: (message, transfer = []) => { workerResponse = structuredClone(message, { transfer }); },
};
vm.runInContext(ts.transpileModule(workerCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, transferContext);
workerHandler({ data: received });
assert.equal(workerResponse.ok, true);
assert.equal(workerResponse.id, 19);
assert.equal(workerResponse.data.transforms.count, 1);
assert.deepEqual([...workerResponse.data.colors], [...transferInput.colorsOverride]);
assert.deepEqual([...received.colorsOverride], [...transferInput.colorsOverride], "Worker output transfer must preserve the received input");
console.log("PASS production glyph worker transports physical RGB with owned buffers and atomic output");




const uiFile = path.join(root, "modules/inspector/panels/SavedFieldVisualizationPanel.tsx");
const uiSource = ts.createSourceFile(uiFile, readFileSync(uiFile, "utf8"), ts.ScriptTarget.Latest, true);
const declarations = uiSource.statements.filter(node => ts.isFunctionDeclaration(node) && ["SavedFieldVisualizationInspector", "SavedFieldVisualizationPanel", "SavedFieldSlider"].includes(node.name?.text)).map(node => node.getText(uiSource)).join("\n");
const controlsFile = path.join(root, "modules/inspector/panels/ObjectVisualizationTargetSection.tsx");
const controlsSource = ts.createSourceFile(controlsFile, readFileSync(controlsFile, "utf8"), ts.ScriptTarget.Latest, true);
const numericDeclarations = ["NumberField", "formatNumericControlValue"].map(name =>
  controlsSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(controlsSource)).join("\n");
const rangeFile = path.join(root, "modules/inspector/panels/antenna/AntennaColorRangeControl.tsx");
const rangeSource = ts.createSourceFile(rangeFile, readFileSync(rangeFile, "utf8"), ts.ScriptTarget.Latest, true);
const rangeDeclaration = rangeSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "AntennaColorRangeControl").getText(rangeSource);
const rangeParser = await moduleAt(path.join(root, "kernel/visualization/antennaColorRange.ts"));
await rangeParser.evaluate();
let passes, sliders, buttons, overview, clearedSelection = 0;
let banners = [], fields = [], inspectorResource, inspectorPresentation, inspectorProjectMatches = true;
const selection = { get: () => ({ ref }), clear: () => { clearedSelection++; selection.get = () => ({ ref: null }); } };
const bindings = {
  parseAntennaColorRange: rangeParser.namespace.parseAntennaColorRange,
  FormField: props => { fields.push(props); return React.createElement("input", { "aria-label": props.label, disabled: props.disabled, value: props.value, onChange: props.onChange }); },
  useKernel: () => ({ selection }), useObjectVisualizationController: () => controller,
  useSavedFieldPresentation: () => ({ presentation: inspectorPresentation, projectMatches: inspectorProjectMatches }),
  useMaterializedDatasetResource: () => inspectorResource,
  materializedDatasetSelectionMatches: presentationModule.namespace.materializedDatasetSelectionMatches,
  useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
  returnToCurrentFieldView, resolveSavedFieldViewportMetadataEligibility,
  quantityDisplayName: id => id,
  InspectorGroup: ({ title, children }) => React.createElement("section", null, title, children),
  InspectorPropertyRow: ({ label, children }) => React.createElement("div", null, label, children),
  FieldRow: ({ label, value }) => React.createElement("p", null, label, ": ", value),
  FeedbackBanner: ({ message, kind }) => { banners.push({ message, kind }); return React.createElement("p", { role: kind === "warning" ? "status" : "alert" }, message); },
  Button: props => { buttons.push(props); return React.createElement("button", null, props.children); },
  Select: ({ children }) => React.createElement("div", null, children),
  SelectContent: ({ children }) => React.createElement("div", null, children),
  SelectItem: ({ children }) => React.createElement("span", null, children),
  SelectTrigger: ({ children }) => React.createElement("button", null, children),
  SelectValue: () => null,
  ViewportCameraControls: () => React.createElement("p", null, "Shared camera controls"),
  VisualizationInspectorOverview: props => {
    overview = props;
    return React.createElement("div", { "data-slot": "shared-visualization-overview" },
      props.context, props.display, props.surfaceColoring, props.vectors, props.camera, props.advanced);
  },
  Slider: props => { sliders.push(props); return React.createElement("input", { disabled: props.disabled, "aria-label": props["aria-label"] }); },
  VisualizationDisplayPassesControl: ({ items }) => { passes = items; return React.createElement("div"); },
  SCALAR_COLOR_PALETTE_ITEMS: [{ label: "Viridis", value: "viridis" }],
};
const uiCode = `import { ${Object.keys(bindings).join(",")} } from "bindings";\n${numericDeclarations}\n${rangeDeclaration}\n${declarations}`;
const ui = new vm.SourceTextModule(ts.transpileModule(uiCode, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
} }).outputText);
await ui.link(spec => spec === "bindings" ? synthetic("bindings", bindings) : synthetic(spec, require(spec)));
await ui.evaluate();
const render = (dataset, error = null) => {
  sliders = []; buttons = [];
  return renderToStaticMarkup(React.createElement(ui.namespace.SavedFieldVisualizationPanel, { presentation, dataset, error }));
};
const dataset = { integrity: "verified", dataset: { status: { availability: "ready" } }, field: {
  plane: "values",
  descriptor: { quantity_id: "H_ant", unit: "A/m", carrier_id: "saved-carrier", sample_location: "node",
    complex_encoding: "real", harmonic_convention: null, value_representation: "physical_field", function_space: { ordering: "by_node", vector_dimension: "3" } },
  coverage: { component_count: "3", total_elements: "14", total_bytes: "336", chunk_count: "1", dtype: "f64", endian: "little" },
} };
for (const [quantity, unit, components] of [["V_electric", "V", "1"], ["J_charge", "A/m^2", "3"], ["H_ant", "A/m", "3"], ["m", "1", "3"]]) {
  for (const [dtype, bytes] of [["f32", 4], ["f64", 8]]) {
    const valid = { ...dataset, field: { ...dataset.field,
      descriptor: { ...dataset.field.descriptor, quantity_id: quantity, unit, function_space: { ordering: "by_node", vector_dimension: components } },
      coverage: { ...dataset.field.coverage, component_count: components, dtype, total_bytes: String(14 * Number(components) * bytes) } } };
    assert.equal(resolveSavedFieldViewportMetadataEligibility(valid).status, "ready", `${quantity} ${dtype}`);
  }
}
controller.setSavedFieldPresentation(ref, "H_ant", "3");
let html = render(dataset);
assert.ok(html.includes("H_ant · A/m"));
assert.ok(html.includes('data-slot="shared-visualization-overview"'), "Saved fields must use the common Inspector layout");
assert.ok(html.includes("Shared camera controls"));
assert.equal(overview.quantitySource, "H_ant · A/m");
assert.equal(overview.dataState, "Metadata verified");
assert.equal(overview.meshState, "Checked when displayed");
assert.equal(overview.clipping, undefined, "Do not offer unqualified saved-carrier clipping controls");
assert.ok(html.includes("Physical field"));
assert.ok(html.includes("Automatic per component"));
assert.ok(passes.some(item => item.id === "visible"));
assert.ok(passes.some(item => item.id === "legend"));
assert.ok(html.includes("14 / 3"));
assert.ok(html.includes("may cover only part of space"));
assert.ok(!html.includes("frozen_spins"));
assert.equal(passes.find(item => item.id === "vectors").disabled, false);
passes.find(item => item.id === "vectors").onToggle();
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.vectorsVisible, false);
// The render's captured settings requested true, so toggling writes false locally.
const beforeDrag = controller.getSnapshot();
sliders.find(item => item["aria-label"] === "Arrow length").onValueChange([3]);
assert.equal(controller.getSnapshot(), beforeDrag, "Dragging only edits the local numeric draft");
sliders.find(item => item["aria-label"] === "Arrow length").onValueCommit([3]);
assert.equal(controller.getSnapshot().savedFieldPresentation.settings.vectorLengthScale, 3);
assert.equal(sliders.find(item => item["aria-label"] === "Arrow budget").max, 14);
assert.equal(sliders.find(item => item["aria-label"] === "Arrow budget").value[0], 7, "Preserve the requested budget below the sample limit");
assert.ok(sliders.some(item => item["aria-label"] === "Wireframe opacity"));
html = render(null);
assert.ok(html.includes("Verifying saved field"));
assert.ok(overview.quantitySource.includes("H_ant"), "Pinned quantity must remain visible while metadata loads");
assert.equal(overview.dataState, "Loading metadata");
assert.equal(overview.enabledPassCount, 0);
assert.ok(passes.every(item => item.disabled));
html = render({ ...dataset, field: { ...dataset.field, descriptor: { ...dataset.field.descriptor, quantity_id: "V_electric", unit: "V", function_space: { ordering: "by_node", vector_dimension: "1" } }, coverage: { ...dataset.field.coverage, component_count: "1", total_elements: "4", total_bytes: "32" } } });
assert.ok(html.includes("scalar and has no vector arrows"));
assert.equal(passes.find(item => item.id === "vectors").disabled, true);
assert.equal(sliders.some(item => item["aria-label"] === "Arrow length"), false);
for (const [name, fieldPatch] of [
  ["tensor", { coverage: { ...dataset.field.coverage, component_count: "9", total_bytes: "1008" } }],
  ["complex", { descriptor: { ...dataset.field.descriptor, complex_encoding: "interleaved" } }],
  ["cell samples", { descriptor: { ...dataset.field.descriptor, sample_location: "cell" } }],
  ["unsupported quantity", { descriptor: { ...dataset.field.descriptor, quantity_id: "H_eff" } }],
  ["oversized", { coverage: { ...dataset.field.coverage, total_bytes: "67108865" } }],
  ["wrong shape", { coverage: { ...dataset.field.coverage, total_bytes: "335" } }],
]) {
  const incompatible = { ...dataset, field: { ...dataset.field, ...fieldPatch } };
  const admission = resolveSavedFieldViewportMetadataEligibility(incompatible);
  assert.equal(admission.status, "unavailable", name);
  const html = render(incompatible);
  assert.ok(html.includes(admission.reason), name);
  assert.ok(!html.includes("scalar and has no vector arrows"), name);
  assert.ok(passes.every(item => item.disabled), name);
  assert.ok(sliders.every(item => item.disabled), name);
}
console.log("PASS incompatible metadata shares renderer admission and exposes its rejection reason");
render(dataset, "Corrupt saved field");
assert.ok(passes.every(item => item.disabled));
assert.ok(sliders.every(item => item.disabled));
buttons.find(item => item.children === "Return to current view").onClick();
assert.equal(clearedSelection, 1);
assert.equal(controller.getSnapshot().savedFieldPresentation, null);
console.log("PASS source/unit rendering, local controls, scalar arrows, errors and current-view exit");
const overviewFile = path.join(root, "modules/inspector/panels/ObjectVisualizationOverview.tsx");
const overviewSource = ts.createSourceFile(overviewFile, readFileSync(overviewFile, "utf8"), ts.ScriptTarget.Latest, true);
const overviewCode = overviewSource.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ["dataStateLabel", "VisualizationInspectorOverview"].includes(node.name?.text)).map(node => node.getText(overviewSource)).join("\n");
let frame;
const icon = () => React.createElement("span");
const overviewBindings = { Box: icon, Camera: icon, Scissors: icon, Settings2: icon,
  InspectorOverviewFrame: props => { frame = props; return React.createElement("div", null, props.sections.map(section =>
    React.createElement("section", { key: section.id }, section.title, section.content))); } };
const overviewModule = new vm.SourceTextModule(ts.transpileModule(
  `import { ${Object.keys(overviewBindings).join(",")} } from "overview-bindings";\n${overviewCode}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText);
await overviewModule.link(spec => spec === "overview-bindings" ? synthetic(spec, overviewBindings) : synthetic(spec, require(spec)));
await overviewModule.evaluate();
for (const clipping of [undefined, null, "Shared live clipping controls"]) {
  const markup = renderToStaticMarkup(React.createElement(overviewModule.namespace.VisualizationInspectorOverview, {
    advanced: "Identity", camera: "Camera", dataState: "Metadata verified", display: "Layers", enabledPassCount: 1,
    meshState: "Checked when displayed", quantitySource: "H_ant · A/m", surfaceColoring: "Colors", vectors: "Vectors", clipping,
  }));
  assert.deepEqual(frame.sections.map(section => section.id), clipping == null ? ["camera", "advanced"] : ["clipping", "camera", "advanced"]);
  assert.equal(markup.includes("Clipping &amp; Section"), clipping != null);
}
render({ ...dataset, dataset: { status: { availability: "missing" } } });
assert.equal(overview.dataState, "Unavailable");
assert.ok(passes.every(item => item.disabled));
assert.ok(sliders.every(item => item.disabled));
console.log("PASS shared Object/Airbox overview keeps live clipping and omits unqualified saved sections");
// Exercise the actual resource-owning Inspector, not only its pure child panel.
const matchingMetadata = { ...metadata.data, ...dataset, dataset: { ...metadata.data.dataset, ...dataset.dataset } };
assert.equal(bindings.materializedDatasetSelectionMatches(ref, matchingMetadata), true);
inspectorPresentation = presentation;
function renderInspector(resource, projectMatches = true) {
  inspectorResource = resource; inspectorProjectMatches = projectMatches;
  passes = []; sliders = []; buttons = []; fields = []; banners = [];
  return renderToStaticMarkup(React.createElement(ui.namespace.SavedFieldVisualizationInspector));
}
function assertHardRejected(resource, projectMatches = true) {
  renderInspector(resource, projectMatches);
  assert.ok(passes.every(item => item.disabled));
  assert.ok(sliders.every(item => item.disabled));
  assert.ok(buttons.filter(item => item.children === "Apply color range").every(item => item.disabled));
}
const readyResource = { status: "ready", data: matchingMetadata, error: null, refreshError: null };
assertHardRejected({ status: "loading", data: null, error: null, refreshError: null });
assertHardRejected({ status: "error", data: null, error: { message: "Initial metadata request failed" }, refreshError: null });
assertHardRejected({ ...readyResource, data: null, refreshError: { message: "No verified snapshot exists" } });
assertHardRejected({ ...readyResource, error: { message: "Fatal metadata validation failure" } });
assertHardRejected({ ...readyResource, data: { ...matchingMetadata, manifest_object_ref: "foreign-manifest" } });
for (const status of ["loading", "stale"]) {
  assertHardRejected({ ...readyResource, status, data: { ...matchingMetadata, manifest_object_ref: "foreign-manifest" },
    refreshError: { message: "antenna_store_busy" } });
  assert.ok(banners.some(banner => banner.kind === "error" && banner.message.includes("identity")),
    "Mismatched retained metadata remains a hard identity failure during refresh");
}
assertHardRejected(readyResource, false);
console.log("PASS actual saved Inspector rejects missing, mismatched, foreign-project and initial-error metadata");
function assertMatchingDisplayEnabled(label) {
  assert.equal(passes.find(item => item.id === "vectors").disabled, false, label);
  assert.ok(sliders.length > 0 && sliders.every(item => !item.disabled), label);
  const rangeButtons = buttons.filter(item => item.children === "Apply color range");
  assert.ok(rangeButtons.length > 0 && rangeButtons.every(item => !item.disabled), label);
  const rangeFields = fields.filter(item => item.label === "Color minimum" || item.label === "Color maximum");
  assert.ok(rangeFields.length > 0 && rangeFields.every(item => !item.disabled), label);
  assert.equal(overview.quantitySource, "H_ant · A/m", label);
}
renderInspector(readyResource);
assertMatchingDisplayEnabled("Verified metadata permits local display and range controls");
renderInspector({ ...readyResource, status: "loading" });
assertMatchingDisplayEnabled("Background loading must preserve controls for the matching immutable metadata");
const refreshed = renderInspector({ ...readyResource, refreshError: { message: "antenna_store_busy: temporary metadata refresh failure" } });
assertMatchingDisplayEnabled("Transient metadata refresh failure must not globally disable controls backed by verified matching data");
assert.ok(refreshed.includes("antenna_store_busy"));
assert.ok(banners.some(banner => banner.kind === "warning" && banner.message.includes("antenna_store_busy")), "The failed refresh must remain visible as a warning");
console.log("PASS actual saved Inspector preserves matching controls through loading and transient refresh warnings");
const materializedFile = path.join(root, "modules/inspector/panels/MaterializedDatasetInspectorPanel.tsx");
const materializedSource = ts.createSourceFile(materializedFile, readFileSync(materializedFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let parentRefreshExpression;
function findParentRefresh(node) {
  if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(materializedSource) === "SavedFieldVisualizationPanel") {
    const prop = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(materializedSource) === "refreshWarning");
    parentRefreshExpression = prop?.initializer?.expression?.getText(materializedSource);
  }
  ts.forEachChild(node, findParentRefresh);
}
findParentRefresh(materializedSource);
assert.ok(parentRefreshExpression, "Materialized dataset owner must forward its existing resource refresh warning");
const warningFromParent = new vm.Script(parentRefreshExpression);
assert.equal(warningFromParent.runInNewContext({ resource: { refreshError: { message: "antenna_store_busy" } } }), "antenna_store_busy");
assert.equal(warningFromParent.runInNewContext({ resource: { refreshError: null } }), null);
console.log("PASS materialized dataset parent forwards refresh warning from its existing resource owner");
console.log(JSON.stringify({ status: "passed", scope: "interpreted production controller/adapter and Inspector render", browser_verified: false, unit_test_compilation: false }));
