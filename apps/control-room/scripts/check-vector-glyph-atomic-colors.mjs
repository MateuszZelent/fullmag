// Source-only regression: production model, cache identity and worker buffer transfer.
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
