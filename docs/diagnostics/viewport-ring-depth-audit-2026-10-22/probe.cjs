/* Read-only diagnostic: run in the existing fullmag-master frontend container.
 * Historical source texts are supplied as JSON on stdin. No application source,
 * session state, browser state, dependency cache, or test build is written.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire, stripTypeScriptTypes } = require("node:module");
const { createHash } = require("node:crypto");
const dependencyRequire = createRequire(path.join(process.cwd(), "package.json"));
const ts = dependencyRequire("typescript");
const THREE = dependencyRequire("three");
const historical = JSON.parse(fs.readFileSync(0, "utf8"));
const root = "/opt/fullmag/source/";
const base = "apps/control-room/src/modules/viewport-3d/";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const texts = {};
const read = (name) => texts[name] ??= fs.readFileSync(root + base + name, "utf8");

function select(source, filename, names) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      found.set(node.name.text, node.getText(ast).replace(/^export\s+/, ""));
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          found.set(declaration.name.text, `const ${declaration.getText(ast)};`);
        }
      }
    }
  }
  return names.map((name) => {
    if (!found.has(name)) throw new Error(`Missing declaration ${name} in ${filename}`);
    return found.get(name);
  }).join("\n");
}

function loadFunctions(fitText, clipText, old) {
  const fov = select(read("viewport3dCameraFov.ts"), "fov.ts", [
    "DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES", "isViewport3DCameraFovDegreesValid",
    "resolveViewport3DCameraFovDegrees",
  ]);
  const fit = select(fitText, "fit.tsx", ["FALLBACK_CAMERA_BOUNDS",
    ...(old ? [] : ["CAMERA_FIT_OFFSET_LENGTH", "CAMERA_FIT_MARGIN"]),
    "resolveViewport3DCameraFit"]);
  const clip = select(clipText, "clip.tsx", ["FALLBACK_GRID_SIZE", "resolveViewport3DProjectionCameraClip"]);
  const bounds = select(read("viewport3dRenderModel.ts"), "bounds.ts", [
    "asRecord", "asVec3", "boundsFromMinMax", "boundsFromOptionalMinMax",
    "boundsFromUniverseConfig", "resolveUniverseBounds", "resolveDomainBounds", "combineViewport3DBounds",
  ]);
  const source = [fov, fit, clip, bounds].join("\n");
  const js = stripTypeScriptTypes(source, { mode: "strip" });
  const context = vm.createContext({ Math, Number, Array, Boolean, Vector3: THREE.Vector3, MathUtils: THREE.MathUtils });
  vm.runInContext(js, context);
  return { context, extractedSha256: sha(source), source };
}

async function get(suffix) {
  const response = await fetch(`http://backend:8081/v2/sessions/current/${suffix}`, {
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { path: `/v2/sessions/current/${suffix}`, status: response.status, sha256: sha(text), body: JSON.parse(text) };
}

(async () => {
  const start = new Date().toISOString();
  const [status, scene, universe, domain, visualization] = await Promise.all([
    get("status"), get("model/scene"), get("model/universe"), get("data/domain/meta"), get("visualization/state"),
  ]);
  for (const resource of [status, scene, universe, visualization]) {
    if (resource.status !== 200) throw new Error(`${resource.path}: HTTP ${resource.status}`);
  }
  const current = loadFunctions(read("layers/CameraControls.tsx"), read("layers/Viewport3DScene.tsx"), false);
  const previous = loadFunctions(historical.fit, historical.clip, true);
  const ctx = current.context;
  const objectBounds = scene.body.objects.map((object) => ({
    id: object.id,
    bounds: ctx.boundsFromMinMax(object.geometry.bounds_min, object.geometry.bounds_max),
  }));
  const primitiveBounds = ctx.combineViewport3DBounds(objectBounds.map((object) => object.bounds));
  const universeBounds = ctx.resolveUniverseBounds(universe.body);
  const domainBounds = domain.status === 200 ? ctx.resolveDomainBounds(domain.body) : null;
  const liveBounds = ctx.combineViewport3DBounds([domainBounds ?? universeBounds, primitiveBounds]);
  const camera = historical.replayCamera ?? visualization.body.camera;
  const direction = new THREE.Vector3(...camera.target).sub(new THREE.Vector3(...camera.position)).normalize();
  const ring = scene.body.objects.find((object) => object.id === "cofeb_top_ring");
  if (!ring) throw new Error("Expected audit ring is absent");
  const ringBounds = objectBounds.find((object) => object.id === ring.id).bounds;
  const cameraPosition = new THREE.Vector3(...camera.position);
  const centerDepth = new THREE.Vector3(...liveBounds.center).sub(cameraPosition).dot(direction);
  const ringDepth = new THREE.Vector3(...ringBounds.center).sub(cameraPosition).dot(direction);
  const report = {
    schema: "fullmag.viewport-ring-depth-diagnostic.v1", startUtc: start, endUtc: null,
    sourceHead: historical.head, baselineCommit: historical.commit, container: "fullmag-master-frontend-1",
    threeRevision: THREE.REVISION, evidenceClass: "EXTRACTED_SOURCE_EXECUTION_WITH_LIVE_HTTP_INPUTS_NO_BROWSER",
    note: "Depth bits are hypothetical; no WebGL context or pixel was measured. Baseline is an extracted-function comparison, not a historical application run. Bounds follow the unmaterialized path (domain/universe plus authored objects); current topology buffers are not fetched, so this does not assert the current rendered mesh bounds.",
    inputStatus: { session: status.body.session, runtimeBundleVersion: status.body.runtime_bundle_version,
      domain: status.body.domain, solver: status.body.solver, resources: status.body.resources },
    resources: [status, scene, universe, domain, visualization].map(({path, status, sha256}) => ({path, status, sha256})),
    inputs: {scene: scene.body, universe: universe.body, domain: domain.body, visualization: visualization.body},
    bounds: {objectBounds, primitiveBounds, universeBounds, domainBounds, liveBounds},
    camera, cameraInputSource: historical.replayCamera ? historical.replayCameraSource : "same-batch live visualization/state",
    liveCameraAtProbeTime: visualization.body.camera,
    centerDepthM: centerDepth, nearestSphereDepthM: centerDepth - liveBounds.radius,
    ringCenterDepthM: ringDepth, assumedDepthBits: [16, 24], comparison: [],
    sourceHashes: {}, extractedFunctions: {current: current.source, baseline: previous.source},
  };
  for (const aspect of [1, 1.6, 2.2]) {
    const options = { aspect, fovDegrees: camera.fov_degrees };
    const now = ctx.resolveViewport3DProjectionCameraClip(liveBounds, camera, options);
    const before = previous.context.resolveViewport3DProjectionCameraClip(liveBounds, camera);
    const depth = (z, {near:n, far:f}) => f / (f - n) - f * n / ((f - n) * z);
    const quantum = (z, {near:n, far:f}, bits) => z * z * (f - n) / (f * n * (2 ** bits - 1));
    const axialProjection = Math.abs(direction.x) * ring.geometry.geometry_params.base.geometry_params.height;
    report.comparison.push({aspect, current: now, baseline: before,
      nearDecreaseFactor: before.near / now.near,
      centerQuantumM: Object.fromEntries([16,24].map((bits) => [bits, {current: quantum(ringDepth, now, bits), baseline: quantum(ringDepth, before, bits)}])),
      axialThicknessProjectedM: axialProjection,
      illustrativeDepthPairs: [5e-9, 15e-9, 50e-9].map((separation) => ({
        separationM: separation,
        currentLevels24: [ringDepth, ringDepth + separation].map(z => Math.round(depth(z, now) * (2**24-1))),
        baselineLevels24: [ringDepth, ringDepth + separation].map(z => Math.round(depth(z, before) * (2**24-1))),
      })),
    });
  }
  report.boundsSensitivity = {
    fullScene: ctx.resolveViewport3DProjectionCameraClip(liveBounds, camera),
    primitivesOnly: ctx.resolveViewport3DProjectionCameraClip(primitiveBounds, camera),
    ringOnly: ctx.resolveViewport3DProjectionCameraClip(ringBounds, camera),
    note: "Hypothetical inputs to the same function; changing bounds is not proposed as a complete fix.",
  };
  for (const [name, text] of Object.entries(texts)) {
    const after = fs.readFileSync(root + base + name, "utf8");
    report.sourceHashes[base + name] = {before: sha(text), after: sha(after), unchanged: text === after};
  }
  const finalStatus = await get("status");
  const finalVisualization = await get("visualization/state");
  report.inputStability = {
    sameSession: finalStatus.body.session.session_epoch === status.body.session.session_epoch,
    sameSceneRevision: finalStatus.body.resources.scene_revision === status.body.resources.scene_revision,
    sameVisualization: finalVisualization.sha256 === visualization.sha256,
  };
  report.endUtc = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
