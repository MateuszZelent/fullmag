// Source-only production-hook regression with real Three buffers and GPU upload queue.
// No browser/WebGL context is created; attribute adoption is not a GPU draw proof.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const Three = await import("three");
const root = fileURLToPath(new URL("../src/", import.meta.url));
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new vm.SourceTextModule(output, { identifier: file }); modules.set(file, mod); return mod;
}
async function moduleAt(relative) {
  const mod = load(path.join(root, relative));
  if (mod.status === "unlinked") await mod.link((spec, parent) => {
    assert.ok(spec.startsWith(".") || spec.startsWith("@/"), `Unexpected dependency ${spec}`);
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(parent.identifier), spec);
    const target = [base, `${base}.ts`, path.join(base, "index.ts")].find(existsSync);
    assert.ok(target, `Unresolved ${spec}`); return load(target);
  });
  await mod.evaluate(); return mod.namespace;
}
const gpu = await moduleAt("modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts");
const layerFile = path.join(root, "modules/viewport-3d/layers/VectorFieldLayer.tsx");
const source = ts.createSourceFile(layerFile, readFileSync(layerFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["useVectorGlyphUpload", "buildVectorGlyphUploadBatches", "markVectorGlyphAttributeRange",
  "createVectorGlyphColorUploadRollback", "createVectorGlyphMatrixUploadRollback", "restoreVectorGlyphUpdateRanges",
  "syncVectorGlyphColorState", "estimateVectorGlyphTransformBytes", "createVectorGlyphUploadKeys"];
const constants = ["UNIT_Y", "VECTOR_GLYPH_UPLOAD_BATCH_SIZE", "VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS",
  "VECTOR_GLYPH_COLOR_UPLOAD_MEASURE", "VECTOR_GLYPH_MATRIX_UPLOAD_MEASURE"];
const declarations = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text) || ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => constants.includes(declaration.name.getText(source))));
assert.equal(declarations.filter(ts.isFunctionDeclaration).length, names.length, "Load the production hook and its helpers");
const code = ts.transpileModule(declarations.map(node => node.getText(source)).join("\n").replace(/^export /gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const count = 257;
function transforms(shift = 0) {
  return { count, directions: Float32Array.from(Array.from({ length: count }, () => [0,1,0]).flat()),
    shaftCenters: Float32Array.from(Array.from({ length: count }, (_, i) => [i + shift, 1, 2]).flat()),
    headCenters: Float32Array.from(Array.from({ length: count }, (_, i) => [i + shift, 3, 4]).flat()),
    shaftScales: new Float32Array(count * 3).fill(1), headScales: new Float32Array(count * 3).fill(2) };
}
function fixture() {
  const scheduled = new Map(), diagnostics = [], tickets = [], adoptions = [], marks = [];
  let nextFrame = 0, effects = [], previousEffects = [], memos = [], memoIndex = 0;
  const geometry = new Three.BoxGeometry(), material = new Three.MeshBasicMaterial({ color: "white", vertexColors: true });
  const shaft = new Three.InstancedMesh(geometry, material, count), head = new Three.InstancedMesh(geometry, material, count);
  shaft.count = head.count = 2;
  const colors = new Three.InstancedBufferAttribute(new Float32Array(count * 3).fill(.125), 3);
  shaft.instanceColor = head.instanceColor = colors;
  const priorColors = [...colors.array], priorShaft = [...shaft.instanceMatrix.array], priorHead = [...head.instanceMatrix.array];
  const versions = { colors: colors.version, shaft: shaft.instanceMatrix.version, head: head.instanceMatrix.version };
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const bindings = { ...Three, AbortController,
    useMemo: (factory, deps) => { const index = memoIndex++, previous = memos[index];
      if (previous && equalDeps(previous.deps, deps)) return previous.value;
      const value = factory(); memos[index] = { deps, value }; return value; },
    useEffect: (effect, deps) => effects.push({ effect, deps }),
    createViewport3DGpuUploadManager: options => {
      const actual = gpu.createViewport3DGpuUploadManager({ ...options, now: () => 0,
        policy: { ...options.policy, maxItemsPerSlice: 256 },
        scheduleFrame: callback => { const id = ++nextFrame; scheduled.set(id, callback); return id; },
        cancelFrame: id => scheduled.delete(id), onDiagnosticRecord: record => diagnostics.push(record) });
      return { ...actual, enqueue: ticket => { tickets.push(ticket); actual.enqueue(ticket); } };
    },
    markVectorGlyphWork: name => name,
    measureVectorGlyphWork: name => marks.push(name), clearVectorGlyphWorkMark: () => {},
  };
  const context = vm.createContext(bindings); vm.runInContext(code, context);
  const base = { buildKey: "old-to-new", glyphColors: new Float32Array(count * 3).fill(.75), glyphCount: count,
    glyphTransforms: transforms(10), shaftRef: { current: shaft }, headRef: { current: head }, instanceColorAttr: colors,
    invalidate: () => {}, material, materialColor: "white", targetRevision: "field=1",
    tracker: { recordDirtyFrame: () => {} },
    transformScratch: { direction: new Three.Vector3(), matrix: new Three.Matrix4(), position: new Three.Vector3(), quaternion: new Three.Quaternion(), scale: new Three.Vector3() } };
  function render(patch = {}) {
    effects = []; memoIndex = 0;
    context.input = { ...base, ...patch, onAdopted: bytes => adoptions.push({ key: patch.buildKey ?? base.buildKey, bytes }) };
    vm.runInContext("useVectorGlyphUpload(input)", context);
    const next = effects.map((entry, index) => ({ ...entry, same: equalDeps(previousEffects[index]?.deps, entry.deps) }));
    next.forEach((entry, index) => { if (!entry.same) previousEffects[index]?.cleanup?.(); });
    next.forEach((entry, index) => { entry.cleanup = entry.same ? previousEffects[index]?.cleanup : entry.effect(); });
    previousEffects = next;
  }
  function frame() { const entry = scheduled.entries().next().value; assert.ok(entry, "An upload frame must be queued"); scheduled.delete(entry[0]); entry[1](); }
  function drain() { let guard = 0; while (scheduled.size) { assert.ok(++guard < 20, "Bounded upload should settle"); frame(); } }
  function assertOld() {
    assert.deepEqual([...colors.array], priorColors); assert.deepEqual([...shaft.instanceMatrix.array], priorShaft); assert.deepEqual([...head.instanceMatrix.array], priorHead);
    assert.equal(shaft.count, 2); assert.equal(head.count, 2);
  }
  function unmount() { previousEffects.forEach(entry => entry.cleanup?.()); previousEffects = []; }
  function dispose() { unmount(); drain(); geometry.dispose(); material.dispose(); }
  return { render, frame, drain, unmount, dispose, assertOld, scheduled, diagnostics, tickets, adoptions, marks,
    shaft, head, colors, material, versions, base };
}
check("one actual GPU ticket preserves old visible attributes until both batches complete", () => {
  const f = fixture();
  try {
    f.render(); assert.equal(f.tickets.length, 1, "RGB and matrices must share one ticket");
    assert.equal(f.tickets[0].chunks.length, 2);
    assert.equal(f.tickets[0].estimatedBytes, f.shaft.instanceMatrix.array.byteLength +
      f.head.instanceMatrix.array.byteLength + f.colors.array.byteLength, "Ticket must account for actual expanded GPU attributes");
    f.assertOld();
    f.frame();
    assert.equal(f.adoptions.length, 0); assert.equal(f.shaft.count, 2); assert.equal(f.head.count, 2);
    assert.equal(f.colors.version, f.versions.colors); assert.equal(f.shaft.instanceMatrix.version, f.versions.shaft); assert.equal(f.head.instanceMatrix.version, f.versions.head);
    assert.equal(f.colors.array[0], .75); assert.equal(f.shaft.instanceMatrix.array[12], 10);
    assert.equal(f.colors.array[256 * 3], .125, "Second batch must still contain old staging values");
    f.drain();
    assert.equal(f.adoptions.length, 1); assert.equal(f.shaft.count, count); assert.equal(f.head.count, count);
    assert.deepEqual([...f.colors.array], [...f.base.glyphColors]);
    for (const node of [0, 255, 256]) { assert.equal(f.shaft.instanceMatrix.array[node * 16 + 12], node + 10); assert.equal(f.head.instanceMatrix.array[node * 16 + 13], 3); }
    assert.ok(f.colors.version > f.versions.colors); assert.ok(f.shaft.instanceMatrix.version > f.versions.shaft); assert.ok(f.head.instanceMatrix.version > f.versions.head);
    assert.deepEqual(f.diagnostics.map(record => record.status), ["ready"]);
    assert.equal(f.marks.length, 2, "Both existing performance marks must settle once");
  } finally { f.dispose(); }
});
check("partial cleanup restores both CPU buffers and never adopts the superseded ticket", () => {
  const f = fixture();
  try {
    f.render(); f.frame();
    const replacement = { buildKey: "replacement", glyphColors: new Float32Array(count * 3).fill(.375), glyphTransforms: transforms(20) };
    f.render(replacement); f.assertOld(); assert.equal(f.adoptions.length, 0);
    f.drain();
    assert.deepEqual(f.adoptions.map(receipt => receipt.key), ["replacement"]);
    assert.deepEqual([...f.colors.array], [...replacement.glyphColors]);
    assert.equal(f.shaft.instanceMatrix.array[12], 20);
    assert.deepEqual(f.diagnostics.map(record => record.status), ["aborted", "ready"]);
  } finally { f.dispose(); }
});
check("unmount cancels partial upload and restores the last consistent attributes", () => {
  const f = fixture();
  try { f.render(); f.frame(); f.unmount(); f.assertOld(); f.drain(); assert.equal(f.adoptions.length, 0); }
  finally { f.dispose(); }
});
check("real manager failure rolls back both attributes without adoption", () => {
  const f = fixture();
  try {
    const actual = f.shaft.setMatrixAt.bind(f.shaft);
    f.shaft.setMatrixAt = (index, matrix) => { if (index === 256) throw new Error("Injected second-batch matrix failure"); actual(index, matrix); };
    f.render(); f.drain(); f.assertOld(); assert.equal(f.adoptions.length, 0);
    assert.deepEqual(f.diagnostics.map(record => record.status), ["failed"]);
  } finally { f.dispose(); }
});
check("RGB failure cannot adopt new matrices with old colors", () => {
  const f = fixture();
  try {
    const actual = f.colors.array.set.bind(f.colors.array);
    let injected = false;
    f.colors.array.set = (source, offset) => {
      actual(source, offset);
      if (offset === 256 * 3 && !injected) { injected = true; throw new Error("Injected second-batch RGB failure"); }
    };
    f.render(); f.drain(); f.assertOld(); assert.equal(f.adoptions.length, 0);
    assert.deepEqual(f.diagnostics.map(record => record.status), ["failed"]);
  } finally { f.dispose(); }
});
check("monochrome commits matrices and material state together without RGB input", () => {
  const f = fixture();
  try {
    f.render({ glyphColors: null }); f.frame();
    assert.equal(f.material.vertexColors, true); assert.equal(f.adoptions.length, 0);
    f.drain(); assert.equal(f.material.vertexColors, false); assert.equal(f.shaft.instanceColor, null); assert.equal(f.head.instanceColor, null);
    assert.equal(f.adoptions.length, 1); assert.equal(f.shaft.count, count);
  } finally { f.dispose(); }
});
console.log(JSON.stringify({ status: "passed", checks, scope: "production upload hook, actual GPU upload manager, real Three CPU attributes",
  browser_verified: false, gpu_draw_verified: false, cancellation_manager_verified: true, unit_test_compilation: false }));
