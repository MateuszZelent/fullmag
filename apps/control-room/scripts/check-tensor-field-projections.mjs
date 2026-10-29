import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Optional third argument: an existing managed Control Room dependency stage.
const dependencyRoot = process.argv[3] ? resolve(process.argv[3]) : appRoot;
const lock = readFileSync(resolve(appRoot, "../../pnpm-lock.yaml"), "utf8");
assert.equal(readFileSync(resolve(dependencyRoot, "../../pnpm-lock.yaml"), "utf8"), lock);
const dependencyRequire = createRequire(resolve(dependencyRoot, "package.json"));
const dependencies = Object.fromEntries(["three", "react"].map(name => [name, dependencyRequire.resolve(name)]));
const threePackage = JSON.parse(readFileSync(resolve(dirname(dependencies.three), "../package.json"), "utf8"));
assert.equal(threePackage.exports["."].import, "./build/three.module.js");
dependencies.three = resolve(dirname(dependencies.three), "three.module.js");
dependencies.react = resolve(dirname(dependencyRequire.resolve("react/package.json")), "cjs/react.development.js");
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/") || specifier.startsWith(".")) {
    const target = specifier.startsWith("@/") ? resolve(appRoot, "src", specifier.slice(2))
      : resolve(dirname(fileURLToPath(context.parentURL)), specifier);
    const candidate = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, resolve(target, "index.ts")].find(existsSync);
    if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
  }
  if (specifier === "three" || specifier === "react") return nextResolve(pathToFileURL(dependencies[specifier]).href, context);
  return nextResolve(specifier, context);
} });
const source = (path) => import(pathToFileURL(resolve(appRoot, "src", path)).href);
const { decodeFieldVector } = await source("kernel/api/codecs/fieldVectorCodec.ts");
const { retainTensorSurfaceField, interpolatedTensorFrobenius, projectTensorField, tensorProjectionOptions, normalizeTensorProjection, tensorProjectionComponentLabels } = await source("kernel/api/tensorFieldProjection.ts");
const descriptor = { rank: 2, shape: [3, 3], layout: "flow_major", axes: ["flow", "spin"],
  component_labels: ["Q_xx", "Q_xy", "Q_xz", "Q_yx", "Q_yy", "Q_yz", "Q_zx", "Q_zy", "Q_zz"] };
const samples = [1, -2, 3, -4, 5, -6, 7, -8, 9, -10, 11, -12, 13, -14, 15, -16, 17, -18];
const binary = new ArrayBuffer(48 + samples.length * 8);
const header = new DataView(binary);
new Uint8Array(binary, 0, 4).set(new TextEncoder().encode("FMVP"));
header.setUint8(4, 2); header.setUint8(5, 1); header.setUint8(6, 9);
header.setUint32(12, samples.length, true); header.setUint32(16, 2, true);
header.setUint32(20, 1, true); header.setUint32(24, 1, true);
new Float64Array(binary, 48).set(samples);
const raw = { ...decodeFieldVector(binary), quantityId: "spin_current_tensor", nodeIndices: new Uint32Array([7, 19]),
  domainGenerationId: "domain-5", meshTopologyHash: "mesh-8", sourceRevision: "31", scopeKind: "part", scopeId: "part-9" };
let checks = 0;
for (let c = 0; c < 9; c += 1) {
  const projected = projectTensorField(raw, descriptor, `c${c}`);
  assert.deepEqual([...projected.values], [samples[c], samples[9 + c]]);
  assert.equal(projected.nComp, 1); assert.equal(projected.nodeIndices, raw.nodeIndices);
  assert.equal(projected.sourceRevision, "31"); assert.equal(projected.scopeId, "part-9");
  assert.equal(projectTensorField(raw, descriptor, `c${c}`), projected);
  checks += 6;
}
const norms = projectTensorField(raw, descriptor, "frobenius");
assert.ok(Math.abs(norms.values[0] - Math.sqrt(285)) < 1e-12);
assert.ok(Math.abs(norms.values[1] - Math.sqrt(1824)) < 1e-12); checks += 2;
for (const [spin, expected] of [
  ["x", [1, -4, 7, -10, 13, -16]], ["y", [-2, 5, -8, 11, -14, 17]], ["z", [3, -6, 9, -12, 15, -18]],
]) {
  const projected = projectTensorField(raw, descriptor, `spin_flow_${spin}`);
  assert.deepEqual([...projected.values], expected); assert.equal(projected.nComp, 3); checks += 2;
}
assert.deepEqual([...raw.values], samples); checks += 1;
for (const value of ["full", "x", "y", "z", "c9", "spin_flow_bad"]) {
  assert.equal(normalizeTensorProjection(value), null);
  assert.throws(() => projectTensorField(raw, descriptor, value)); checks += 2;
}
for (const metadata of [null, { ...descriptor, rank: 1 }, { ...descriptor, layout: "spin_major" }, { ...descriptor, axes: ["spin", "flow"] }]) {
  assert.throws(() => projectTensorField(raw, metadata, "c8")); checks += 1;
}
assert.deepEqual(tensorProjectionOptions(descriptor).slice(0, 9).map((option) => option.label), descriptor.component_labels); checks += 1;
const { buildFieldVectorDebugSamples } = await source("modules/viewport-3d/model/scanFieldVectorDebugStatistics.ts");
const debug = buildFieldVectorDebugSamples(raw);
assert.deepEqual(debug.samples[0].componentValues, samples.slice(0, 9));
assert.ok(Math.abs(debug.samples[0].magnitude - Math.sqrt(285)) < 1e-12);
assert.equal(debug.issues.length, 0); checks += 3;
const controller = await source("kernel/visualization/ObjectVisualizationController.ts");
const target = { kind: "object", id: "object:fixture" };
assert.equal(controller.visualizationStateOverrideFromTargetPatch(target, { tensorProjection: "c8" }).style.tensor_projection, "c8");
assert.equal(controller.visualizationStateOverrideFromTargetPatch(target, { tensorProjection: null }).style.tensor_projection, null); checks += 2;
const { buildViewport3DTargetRenderPlan, buildViewport3DPassDemands, planViewport3DFieldResourceRequests, resolveViewport3DFdmNativeLayerFieldRequests } = await source("modules/viewport-3d/model/viewport3DFieldDataPlan.ts");
for (const token of ["c8", "frobenius", "spin_flow_z"]) {
  const plan = buildViewport3DTargetRenderPlan({ quantityId: "spin_current_tensor", targetId: target.id, targetKind: "object", settings: {
    ...controller.DEFAULT_OBJECT_VISUALIZATION, tensorProjection: token, vectorsVisible: true, shaderVisible: true,
    surfaceColorSource: "colormap", viewportColorbarVisible: true,
  } });
  const requests = planViewport3DFieldResourceRequests(buildViewport3DPassDemands(plan));
  assert.equal(requests.length, 1); assert.equal(requests[0].query.component, token === "frobenius" ? "full" : token);
  assert.equal(plan.vectors.visible, token.startsWith("spin_flow_")); checks += 3;
}
const nativeFrobenius = resolveViewport3DFdmNativeLayerFieldRequests({ available: true, maxSamples: 20,
  layers: [{ layerId: "layer-1", settings: { ...controller.DEFAULT_OBJECT_VISUALIZATION,
    activeQuantityId: raw.quantityId, tensorProjection: "frobenius", shaderVisible: true, vectorsVisible: true } }],
});
assert.equal(nativeFrobenius.size, 1); assert.equal(nativeFrobenius.get("layer-1").query.component, "frobenius"); checks += 1;
const bufferModule = await source("modules/viewport-3d/model/viewport3DTargetFieldBuffer.ts");
const indexedRaw = { ...raw, formatVersion: 3, indexing: "explicit_node_indices" };
const makeBuffer = (field, component) => bufferModule.buildViewport3DTargetFieldBuffer({
  fieldVector: field, query: { component, scope_kind: "part", scope_id: "part-9" },
  domain: { domainGenerationId: "domain-5", meshTopologyHash: "mesh-8", meshTopologyRevision: null, pointCount: 20 },
  resourceKey: "raw-fixture", sessionIdentity: { sessionId: "session-1", sessionEpoch: "1", requestScopeEpoch: "1" }, targetIds: [target.id],
});
const rawBuffer = makeBuffer(indexedRaw, "full");
assert.equal(bufferModule.viewport3DTargetFieldBufferCanServeVectors(rawBuffer, raw.quantityId), false);
assert.equal(bufferModule.viewport3DTargetFieldBufferCanServeSurface(rawBuffer, "magnitude", raw.quantityId, "raw_nodal"), false); checks += 2;
const flowBuffer = makeBuffer(projectTensorField(indexedRaw, descriptor, "spin_flow_z"), "spin_flow_z");
assert.equal(flowBuffer.capability, "full-vector-complete");
assert.equal(bufferModule.viewport3DTargetFieldBufferCanServeVectors(flowBuffer, raw.quantityId), true); checks += 2;
const scalarBuffer = makeBuffer(projectTensorField(indexedRaw, descriptor, "c8"), "c8");
assert.equal(scalarBuffer.capability, "scalar-complete");
assert.equal(bufferModule.viewport3DTargetFieldBufferCanServeSurface(scalarBuffer, "magnitude", raw.quantityId), true); checks += 2;
const { buildFieldMapDataPlan } = await source("modules/field-map/model/fieldMapDataPlan.ts");
for (const token of ["c8", "frobenius", "spin_flow_z"]) {
  const plan = buildFieldMapDataPlan({ active: true, component: token, discretization: "fem", includeMesh: false,
    source: { kind: "default" }, quality: "interactive", quantityId: raw.quantityId, resolution: [8, 8], showVectors: true, vectorBudget: 10 });
  assert.equal(plan.requestVectors, token === "spin_flow_z"); assert.equal(plan.query.component, token); checks += 2;
}
assert.deepEqual(tensorProjectionComponentLabels(descriptor, "full", 9), descriptor.component_labels);
assert.deepEqual(tensorProjectionComponentLabels(descriptor, "c8", 1), ["Q_zz"]);
assert.deepEqual(tensorProjectionComponentLabels(descriptor, "spin_flow_z", 3), ["Q_xz", "Q_yz", "Q_zz"]);
assert.equal(tensorProjectionComponentLabels(descriptor, "full", 3), null); checks += 4;
const ack = controller.resolveTargetVisualization({ target, snapshot: { defaults: {}, overrides: {}, version: 0 },
  visualizationState: { targets: { objects: [{ scope: "object", scope_id: "fixture", settings: { tensor_projection: "c8", active_quantity_id: "spin_current_tensor" } }], parts: [], airbox: null } } });
assert.equal(ack.settings.tensorProjection, "c8"); checks += 1;

const mapping = await source("modules/viewport-3d/viewport3dFieldMapping.ts");
const colorBuild = await source("modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts");
const retained = retainTensorSurfaceField(indexedRaw, descriptor);
assert.equal(retained.nComp, 9); assert.equal(retained.values, indexedRaw.values);
assert.equal(retainTensorSurfaceField(indexedRaw, descriptor), retained);
assert.equal(mapping.fieldVectorSupportsScalarColorMode(retained, "magnitude"), true);
assert.equal(mapping.fieldVectorSupportsScalarColorMode(retained, "orientation"), false); checks += 5;
const retainedBuffer = makeBuffer(retained, "full");
assert.equal(retainedBuffer.capability, "tensor-complete");
assert.equal(bufferModule.viewport3DTargetFieldBufferCanServeSurface(retainedBuffer, "magnitude", raw.quantityId), true);
assert.equal(bufferModule.viewport3DTargetFieldBufferCanServeVectors(retainedBuffer, raw.quantityId), false); checks += 3;
const cancellation = retainTensorSurfaceField({ ...raw, indexing: "full", nodeIndices: null, pointCount: 3, valueCount: 27,
  values: Float64Array.from([...samples.slice(0, 9), ...samples.slice(0, 9).map(value => -value), ...Array(9).fill(0)]) }, descriptor);
assert.equal(interpolatedTensorFrobenius(cancellation.values, [0, 1], [0.5, 0.5]), 0);
const color = await colorBuild.buildViewport3DFieldColorBuffer({ fieldVector: cancellation,
  target: { kind: "full-domain", vertexCount: 3 }, shaderOnly: true, colorMode: "magnitude" });
assert.equal(color.colors.length, 0); assert.equal(color.scalarValues, undefined);
assert.equal(color.range.min, 0); assert.ok(Math.abs(color.range.max - Math.sqrt(285)) < 1e-12);
assert.equal(color.tensorRows.reduce((bytes, row) => bytes + row.byteLength, 0), 3 * 36);
assert.equal(colorBuild.estimateViewport3DFieldColorBuildOutputBytes({ fieldVector: cancellation, target: { kind: "full-domain", vertexCount: 3 }, shaderOnly: true }), 108);
for (let c = 0; c < 9; c++) assert.equal(color.tensorRows[Math.floor(c / 3)][c % 3] + color.tensorRows[Math.floor(c / 3)][3 + c % 3], 0); checks += 16;
const face = mapping.buildTensorSurfaceColorBuffer(cancellation, { kind: "surface-faces", surfaceIndices: new Uint32Array([0, 1, 2]), vertexCount: 3 });
assert.equal(face.range.min, 0); assert.equal(face.range.max, 0);
assert.ok(face.tensorRows.every(row => row.every(value => value === 0))); checks += 3;

const depth = retainTensorSurfaceField({ ...cancellation, pointCount: 6, valueCount: 54,
  values: Float64Array.from([...samples.slice(0, 9), ...samples.slice(0, 9), ...samples.slice(0, 9),
    ...samples.slice(0, 9).map(v => -v), ...samples.slice(0, 9).map(v => -v), ...samples.slice(0, 9).map(v => -v)]) }, descriptor);
const thicknessTarget = { kind: "thickness-average-z", vertexCount: 6,
  positions: new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,0.01, 1,0,0.01, 0,1,0.01]), surfaceIndices: new Uint32Array([0,1,2]) };
const averaged = mapping.buildTensorSurfaceColorBuffer(depth, thicknessTarget);
assert.equal(averaged.range.max, 0); assert.ok(averaged.tensorRows.every(row => row.every(v => v === 0)));
assert.equal(averaged.geometryRole, "face_expanded_surface");
const incomplete = { ...depth, indexing: "explicit_node_indices", nodeIndices: new Uint32Array([0,1,3,4,5,2]) };
assert.equal(mapping.buildTensorSurfaceColorBuffer({ ...incomplete, pointCount: 5, valueCount: 45, values: incomplete.values.subarray(0,45), nodeIndices: incomplete.nodeIndices.subarray(0,5) }, { kind: "surface-faces", vertexCount: 6, surfaceIndices: new Uint32Array([0,1,2]) }), null); checks += 4;
const { BufferGeometry, FrontSide } = await import(pathToFileURL(dependencies.three).href);
const shader = await source("modules/viewport-3d/viewport3dScalarSurfaceShader.ts");
const material = shader.createScalarSurfaceShaderMaterial(color, { depthTest: true, depthWrite: true, opacity: 1,
  polygonOffset: false, polygonOffsetFactor: 0, polygonOffsetUnits: 0, side: FrontSide, transparent: false });
assert.ok(material.vertexShader.includes("varying vec3 vTensorRow2"));
assert.ok(material.fragmentShader.includes("dot(vTensorRow2, vTensorRow2)"));
assert.ok(!material.fragmentShader.includes("float v = vScalarValue"));
assert.equal(material.uniforms.fmScalarMax.value, color.range.max / color.tensorScale);
assert.equal(shader.scalarSurfaceShaderVariantKey(color), "scalar:tensor-frobenius"); checks += 5;
const upload = await source("modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts");
const geometry = new BufferGeometry();
const uploadPlan = upload.createViewport3DScalarShaderColorUploadPlan(geometry, color, 3, 1);
assert.equal(uploadPlan.estimatedBytes, 108);
for (const chunk of uploadPlan.chunks) { chunk.upload(); }
// Attribute publication happens atomically at commit, after all staging chunks.
uploadPlan.onVisible();
for (const name of shader.VIEWPORT_3D_TENSOR_ROW_ATTRIBUTES) assert.equal(geometry.getAttribute(name).itemSize, 3);
assert.equal(geometry.getAttribute("fmScalarValue"), undefined); checks += 5;

const recolored = mapping.buildTensorSurfaceColorBuffer(cancellation, { kind: "full-domain", vertexCount: 3 }, "magma", { min: 0, max: 30 });
assert.equal(recolored.tensorRows, color.tensorRows);
assert.equal(upload.canReuseViewport3DScalarShaderAttributes(color, recolored), true);
const program = material.vertexShader;
shader.updateScalarSurfaceShaderMaterial(material, recolored, 0.75);
assert.equal(material.vertexShader, program);
assert.equal(material.uniforms.fmPaletteId.value, 4);
assert.equal(material.uniforms.fmScalarMax.value, 30 / recolored.tensorScale); checks += 5;
const abortedGeometry = new BufferGeometry();
const aborted = upload.createViewport3DScalarShaderColorUploadPlan(abortedGeometry, color, 3, 1);
aborted.chunks[0].upload(); aborted.chunks[0].rollback();
assert.equal(Object.keys(abortedGeometry.attributes).length, 0); checks += 1;
abortedGeometry.dispose();
for (let row = 0; row < 3; row++) assert.deepEqual(Array.from(geometry.getAttribute(shader.VIEWPORT_3D_TENSOR_ROW_ATTRIBUTES[row]).array), Array.from(color.tensorRows[row])); checks += 3;
const abort = new AbortController(); abort.abort();
await assert.rejects(colorBuild.buildViewport3DFieldColorBuffer({ fieldVector: cancellation, target: { kind: "full-domain", vertexCount: 3 }, signal: abort.signal }), { name: "AbortError" }); checks += 1;
assert.equal(colorBuild.estimateViewport3DFieldColorBuildOutputBytes({ fieldVector: cancellation, target: { kind: "full-domain", vertexCount: 4 }, shaderOnly: true }), 144); checks += 1;

const oldArrays = shader.VIEWPORT_3D_TENSOR_ROW_ATTRIBUTES.map(name => geometry.getAttribute(name).array);
const replacement = { ...color, tensorRows: color.tensorRows.map(row => Float32Array.from(row, value => value + 0.1)) };
const replacing = upload.createViewport3DScalarShaderColorUploadPlan(geometry, replacement, 3, 1);
for (const chunk of replacing.chunks) chunk.upload();
for (let row = 0; row < 3; row++) assert.equal(geometry.getAttribute(shader.VIEWPORT_3D_TENSOR_ROW_ATTRIBUTES[row]).array, oldArrays[row]);
replacing.chunks[0].rollback();
for (let row = 0; row < 3; row++) assert.equal(geometry.getAttribute(shader.VIEWPORT_3D_TENSOR_ROW_ATTRIBUTES[row]).array, oldArrays[row]); checks += 6;
const transfers = await source("modules/viewport-3d/field-colors/viewport3dFieldColorBuildWorker.ts");
assert.equal(transfers.transferablesForViewport3DFieldColorBuffer(color).length, 4); checks += 1;
material.dispose(); geometry.dispose();
const dependencyEvidence = Object.fromEntries(Object.entries(dependencies).map(([name, path]) => [name, {
  path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  version: JSON.parse(readFileSync(resolve(dirname(path), "../package.json"), "utf8")).version,
}]));
assert.equal(dependencyEvidence.three.version, "0.186.1"); assert.equal(dependencyEvidence.react.version, "19.2.4");
assert.ok(lock.includes("version: 0.186.1")); assert.ok(lock.includes("version: 19.2.4")); checks += 4;
assert.equal(upload.canReuseViewport3DScalarShaderAttributes(color, { ...recolored, tensorRows: recolored.tensorRows.map(row => row.slice()) }), true);
assert.equal(upload.canReuseViewport3DScalarShaderAttributes(color, { ...recolored, tensorRows: recolored.tensorRows.map(row => row.slice()), tensorCarrierKey: "different-source" }), false); checks += 2;
const receipt = { dependencies: dependencyEvidence, status: "pass", checks, proof: "interpreted_production_typescript_adapter_and_fmvp_codec", browser: "NOT VERIFIED", native_api: "NOT VERIFIED" };
if (process.argv[2]) { const output = resolve(process.argv[2]); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(receipt, null, 2)); }
console.log(JSON.stringify(receipt));
