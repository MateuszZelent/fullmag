import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { MathUtils } from "three";

// Interpret the production store and fit function; no unit-test compilation.
// Clip planes and React lifecycle are outside this focused geometry check.
const read = name => readFileSync(new URL(`../src/modules/viewport-3d/${name}`, import.meta.url), "utf8");
const strip = text => stripTypeScriptTypes(text).replace(/^import[\s\S]*?from ["'][^"']+["'];\s*/gm, "").replaceAll("export ", "");
const fov = vm.runInNewContext(strip(read("viewport3dCameraFov.ts")) +
  "\n({DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES, resolveViewport3DCameraFovDegrees});");
const controls = read("layers/CameraControls.tsx");
const fitSource = controls.slice(controls.indexOf("export function resolveViewport3DCameraFit("), controls.indexOf("export function resolveViewport3DAutoFitOrbitTarget("));
const resolveViewport3DCameraFit = vm.runInNewContext(strip(fitSource) + "\nresolveViewport3DCameraFit;", {
  ...fov, MathUtils,
  resolveViewport3DCameraDepthRange: () => ({ near: 1e-12, far: 1 }),
});
const source = read("hooks/useSavedViewportCamera.ts");
const createStore = vm.runInNewContext(strip(source.slice(0, source.indexOf("export function useSavedViewportCamera("))) + "\ncreateStore;", {
  ...fov, resolveViewport3DCameraFit, VIEWPORT_3D_WORLD_UP: [0, 0, 1],
  DEFAULT_VIEWPORT_3D_CAMERA_STATE: { position: [3e-6, 3e-6, 3e-6], target: [0, 0, 0], up: [0, 0, 1] },
});
const field = { center: [2e-6, -3e-6, 7e-9], size: [4e-6, 1e-7, 1.74e-8], radius: Math.hypot(4e-6, 1e-7, 1.74e-8) / 2 };
const scene = { center: [0, 0, 0], size: [20e-6, 8e-6, 1e-6], radius: Math.hypot(20e-6, 8e-6, 1e-6) / 2 };
const store = createStore();
store.activate("A");
store.fitCamera("A", scene, 1.7);
const whole = store.getSnapshot().camera;
store.fitCamera("A", field, 1.7);
const focused = store.getSnapshot().camera;
const distance = camera => Math.hypot(...camera.position.map((v, i) => v - camera.target[i]));
assert.deepEqual([...focused.target], field.center);
assert.ok(distance(focused) < distance(whole) / 4, "small carrier must be framed closer than the source scene");
for (const aspect of [0.4, 1, 2]) {
  store.patchCamera("A", { projection: "orthographic", orthographic_scale: 1 });
  store.fitCamera("A", field, aspect);
  const camera = store.getSnapshot().camera;
  assert.equal(camera.projection, "orthographic");
  assert.ok(camera.orthographic_scale >= 2 * field.radius);
  assert.ok(camera.orthographic_scale * aspect >= 2 * field.radius);
  assert.ok(camera.orthographic_scale < 1e-4, "old zoom must not survive fit");
}
const saved = JSON.stringify(store.getSnapshot());
store.activate("B");
store.fitCamera("B", scene, 1);
store.activate("A");
assert.equal(JSON.stringify(store.getSnapshot()), saved, "identity switch must preserve A's camera");
store.activate(null);
assert.equal(store.getSnapshot().identityKey, null);
store.activate("A");
assert.equal(JSON.stringify(store.getSnapshot()), saved);
console.log("PASS saved camera: distinct field/scene framing, translated carrier, three orthographic aspects, identity restoration; clip/WebGL/React not covered");

// Exercise the production callback with its captured identity; React scheduling
// itself is not mocked or claimed as covered by this interpreter check.
const callbackSource = source.slice(source.indexOf("  const fitCamera = useCallback("), source.indexOf("  const resetCamera = useCallback("));
const activeIdentityRef = { current: "A" };
const callback = vm.runInNewContext(strip(callbackSource) + "\nfitCamera;", {
  activeIdentityKey: "A", activeIdentityRef, bounds: scene, store,
  useCallback: fn => fn,
});
callback(1, field);
assert.deepEqual([...store.getSnapshot().camera.target], field.center);
callback(1);
assert.deepEqual([...store.getSnapshot().camera.target], scene.center);
const unchanged = store.getSnapshot();
assert.equal(callback(1, null), false);
assert.equal(store.getSnapshot(), unchanged);
store.activate("B");
activeIdentityRef.current = "B";
const b = store.getSnapshot();
assert.equal(callback(1, field), false, "stale A callback must not activate A or change B");
assert.equal(store.getSnapshot(), b);
console.log("PASS fit callback: explicit carrier, default scene, missing bounds and stale identity fence");
