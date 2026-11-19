// Run in the selected Compose frontend app directory. Production declarations
// use Node type erasure; no unit-test build, browser, or application mutation.
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire, stripTypeScriptTypes } = require("node:module");
const { createHash } = require("node:crypto");
const requireApp = createRequire(process.cwd() + "/package.json");
const ts = requireApp("typescript");
const THREE = requireApp("three");
const root = "/opt/fullmag/source/apps/control-room/src/modules/viewport-3d/";
const sources = {};
const hash = (value) => createHash("sha256").update(value).digest("hex");
function declarations(file, names) {
  const source = sources[file] = fs.readFileSync(root + file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.filter((node) =>
    (ts.isFunctionDeclaration(node) && node.name && (!names || names.includes(node.name.text))) ||
    (!names && ts.isVariableStatement(node)),
  ).map((node) => node.getText(ast).replace(/^export\s+/, "")).join("\n");
}
const source = [
  declarations("viewport3dPrimitiveModel.ts", ["cardinalAxisIndex", "planeAxesForCardinalAxis"]),
  declarations("layers/PrimitiveObjectLayerModel.ts", ["createPrimitiveObjectGeometry", "createBoxCylinderDifferenceGeometry", "createCylinderCylinderDifferenceGeometry", "remapExtrudedCardinalAxisGeometry"]),
  declarations("layers/primitiveWireframeGeometry.ts"),
  declarations("layers/viewport3DCameraClip.ts"),
].join("\n");
const api = vm.runInNewContext(stripTypeScriptTypes(source, { mode: "strip" }) +
  "\n({ createPrimitiveObjectGeometry, buildPrimitiveWireframeGeometry, resolveViewport3DCameraDepthRange })", { ...THREE });
const results = [];
const triangleWireframe = process.argv.includes("--triangle-wireframe");
function inspect(object, label) {
  const surface = api.createPrimitiveObjectGeometry(object);
  const edges = triangleWireframe ? new THREE.WireframeGeometry(surface) : api.buildPrimitiveWireframeGeometry(object, surface);
  const expectedEndpoints = { "cylinder-cylinder-difference": 1024, "box-cylinder-difference": 536, box: 24, sphere: 704, cylinder: 144 }[object.kind];
  const key = (a, i) => `${a.getX(i)},${a.getY(i)},${a.getZ(i)}`;
  const position = surface.getAttribute("position");
  const surfaceEdges = new Set();
  const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const indexAt = (i) => surface.index ? surface.index.getX(i) : i;
  for (let offset = 0; offset < (surface.index?.count ?? position.count); offset += 3) {
    const t = [0, 1, 2].map((n) => key(position, indexAt(offset + n)));
    for (let i = 0; i < 3; i += 1) surfaceEdges.add(edgeKey(t[i], t[(i + 1) % 3]));
  }
  let missing = 0;
  const p = edges?.getAttribute("position");
  if (p) for (let i = 0; i < p.count; i += 2) {
    if (!surfaceEdges.has(edgeKey(key(p, i), key(p, i + 1)))) missing += 1;
  }
  results.push({ label, endpoints: p?.count ?? 0, expected_endpoints: expectedEndpoints, off_surface_segments: missing });
  surface.dispose();
  edges?.dispose();
}
for (const scale of [1e-9, 1e-6, 1]) {
  for (let a = 0; a < 3; a += 1) {
    const axis = [0, 0, 0]; axis[a] = 1;
    const size = [300, 300, 300].map((n) => n * scale); size[a] = 50 * scale;
    const outerCenter = [11, -7, 23].map((n) => n * scale);
    const innerCenter = [...outerCenter];
    const plane = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
    innerCenter[plane[0]] += 7 * scale; innerCenter[plane[1]] -= 5 * scale;
    inspect({ kind: "cylinder-cylinder-difference", bounds: { size }, csgPreview: {
      kind: "cylinder-cylinder-difference", cylinderAxis: axis, boundsSize: size,
      innerCenter, outerCenter, outerRadius: 150 * scale, innerRadius: 50 * scale, outerHeight: 50 * scale,
    } }, `ring:${a}:${scale}`);
    inspect({ kind: "box-cylinder-difference", bounds: { size }, csgPreview: {
      kind: "box-cylinder-difference", cylinderAxis: axis, boxSize: size,
      cylinderRadius: 50 * scale, cylinderCenter: [0, 0, 0],
    } }, `box-hole:${a}:${scale}`);
    const nonuniformSize = [20, 30, 40].map((n) => n * scale);
    const holeCenter = [0, 0, 0];
    holeCenter[plane[0]] = 2 * scale; holeCenter[plane[1]] = -3 * scale;
    inspect({ kind: "box-cylinder-difference", bounds: { size: nonuniformSize }, csgPreview: {
      kind: "box-cylinder-difference", cylinderAxis: axis, boxSize: nonuniformSize,
      cylinderRadius: 4 * scale, cylinderCenter: holeCenter,
    } }, `box-hole-nonuniform:${a}:${scale}`);
  }
  for (const kind of ["box", "sphere", "cylinder"]) {
    inspect({ kind, bounds: { size: [300 * scale, 300 * scale, 50 * scale] } }, `${kind}:${scale}`);
  }
}
const bounds = { center: [0, 0, 0], radius: 1.85e-6, size: [2.8e-6, 2.1e-6, 1.2e-6] };
const position = { x: 1.6710714031932422e-7, y: -6.101199092239823e-7, z: 2.0428454917790962e-7 };
const forward = { x: -position.x, y: -position.y, z: 1.55e-7 - position.z };
const legacyDepth = process.argv.includes("--legacy-depth");
const depthRange = legacyDepth ? () => ({ near: 1e-12, far: 1e-3 }) : api.resolveViewport3DCameraDepthRange;
const focusDistance = Math.hypot(forward.x, forward.y, forward.z);
const clip = depthRange(bounds, position, forward, focusDistance);
const tangential = [-1e-9, 0, 1e-12, 1e-9].map((z) => depthRange(bounds, { x: 6e-7, y: 0, z }, { x: 0, y: 0, z: -1 }, 6e-7));
const depthCode = (depth, range) => Math.round((range.far / (range.far - range.near) -
  range.far * range.near / ((range.far - range.near) * depth)) * (2 ** 24 - 1));
const filmLevels = (depth, range) => depthCode(depth + 1.6e-9, range) - depthCode(depth, range);
const scaleChecks = [1e-6, 1e-3, 1e3, 1e6].map((scale) => {
  const range = depthRange({ ...bounds, radius: bounds.radius * scale },
    Object.fromEntries(Object.entries(position).map(([key, value]) => [key, value * scale])),
    forward, focusDistance * scale);
  return { scale, passed: Math.abs(range.near / scale / clip.near - 1) < 1e-10 &&
    Math.abs(range.far / scale / clip.far - 1) < 1e-10 };
});
const depthChecks = {
  finite_ordered: Number.isFinite(clip.near) && Number.isFinite(clip.far) && clip.near > 0 && clip.far > clip.near,
  thin_film_levels: filmLevels(6.34057e-7, clip),
  tangential_film_levels: tangential.map((range) => filmLevels(6e-7, range)),
  orthographic_step_m: (clip.far - clip.near) / (2 ** 24 - 1),
  scale_checks: scaleChecks,
};
const depthPassed = depthChecks.finite_ordered && depthChecks.thin_film_levels > 20 &&
  depthChecks.tangential_film_levels.every((levels) => levels > 20) &&
  depthChecks.orthographic_step_m < 1.6e-9 / 1000 && scaleChecks.every((check) => check.passed);
const stable = Object.entries(sources).every(([file, text]) => text === fs.readFileSync(root + file, "utf8"));
console.log(JSON.stringify({ schema: "fullmag.viewport-depth-source-diagnostic.v1", evidence: "production declarations; Node type erasure; no unit-test build; no WebGL", three_revision: THREE.REVISION, source_hashes: Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, hash(text)])), extracted_sha256: hash(source), sources_stable: stable, geometry: results, geometry_policy: triangleWireframe ? "all-triangles-negative-control" : "production", clip, tangential, depth_policy: legacyDepth ? "legacy-negative-control" : "production", depth_checks: depthChecks, depth_passed: depthPassed }, null, 2));
process.exitCode = stable && depthPassed && results.every((r) => r.endpoints === r.expected_endpoints && r.off_surface_segments === 0) ? 0 : 1;
