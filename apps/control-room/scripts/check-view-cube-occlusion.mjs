import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3 } from "three";
import { WebGLRenderList } from "three/src/renderers/webgl/WebGLRenderLists.js";

const orientation = new URL("../src/modules/viewport-3d/orientation/", import.meta.url);
const constants = readFileSync(new URL("orientationHudConstants.ts", orientation), "utf8");
const { ORBIT_RING_RADIUS, VIEW_CUBE_HALF, VIEW_CUBE_FACE_SIZE, WIDGET_RENDER_ORDER } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(constants)).toString("base64")}`
);
const source = readFileSync(new URL("ViewCube3DBox.tsx", orientation), "utf8");
const prepass = source.slice(source.indexOf("onBeforeRender="), source.indexOf("userData={{ viewCubeFallbackBox"));
assert.match(prepass, /renderer\.clearDepth\(\)/);
assert.match(prepass, /renderOrder=\{WIDGET_RENDER_ORDER - 1\}/);
assert.match(prepass, /colorWrite=\{false\}[\s\S]*depthTest\s+depthWrite\s+transparent/);
assert.match(prepass, /raycast=\{\(\) => \{\}\}/);
const ring = source.slice(source.indexOf("{/* Compass band:"), source.indexOf("function useLatestRef"));
assert.equal((ring.match(/depthTest(?:\s|>)/g) ?? []).length, 5, "band, rims, ticks, labels and chevrons must all depth-test");
assert.ok(!ring.includes("depthTest={false}"));
assert.match(source, /<group position=\{\[0, 0, -VIEW_CUBE_HALF\]\}/);
assert.match(source, /<group ref=\{cubeGroupRef\} renderOrder=\{WIDGET_RENDER_ORDER\}>/);
assert.match(source, /<group\s+ref=\{groupRef\}\s+position=\{placement.position\}\s+renderOrder=\{WIDGET_RENDER_ORDER\}/);
assert.match(source, /<group position=\{\[0, 0, 0\.28\]\} ref=\{ref\} renderOrder=\{WIDGET_RENDER_ORDER\}>/);
const text = readFileSync(new URL("hudText.tsx", orientation), "utf8");
assert.match(text, /depthTest = false/);
assert.match(text, /depthTest=\{depthTest\}/);

// Exercise Three's actual transparent-list ordering, including the ring's
// groupOrder (which takes precedence over each decoration's renderOrder).
const list = WebGLRenderList();
const material = new MeshBasicMaterial({ transparent: true });
const geometry = new BoxGeometry(VIEW_CUBE_FACE_SIZE, VIEW_CUBE_FACE_SIZE, VIEW_CUBE_FACE_SIZE);
const root = new Group();
function group(parent, renderOrder) {
  const child = new Group();
  child.renderOrder = renderOrder;
  parent.add(child);
  return child;
}
function mesh(parent, name, renderOrder) {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.renderOrder = renderOrder;
  parent.add(mesh);
}
mesh(root, "scene", 0);
mesh(group(root, 120), "scene-overlay", 120);
const cubeGroup = group(root, WIDGET_RENDER_ORDER);
mesh(cubeGroup, "cube-depth", WIDGET_RENDER_ORDER - 1);
mesh(cubeGroup, "cube-body", WIDGET_RENDER_ORDER);
const faceGroup = group(cubeGroup, WIDGET_RENDER_ORDER);
mesh(faceGroup, "cube-face", WIDGET_RENDER_ORDER + 3);
const labelGroup = group(faceGroup, WIDGET_RENDER_ORDER);
mesh(labelGroup, "cube-label", WIDGET_RENDER_ORDER + 5);
mesh(group(root, WIDGET_RENDER_ORDER + 1), "ring", WIDGET_RENDER_ORDER + 1);
// Mirror the installed WebGLRenderer projectObject rule: every nested Group
// replaces groupOrder, including a default-zero face or label Group. Using
// inherited parent order here would miss the blank-cube regression entirely.
function collect(object, groupOrder = 0) {
  if (object.isGroup) groupOrder = object.renderOrder;
  if (object.isMesh) list.push(object, geometry, material, groupOrder, 0, null);
  for (const child of object.children) collect(child, groupOrder);
}
collect(root);
list.sort();
assert.deepEqual(list.transparent.map(({ object }) => object.name), ["scene", "scene-overlay", "cube-depth", "cube-body", "cube-face", "cube-label", "ring"]);

// Independent CPU ray intersections verify that the compass really has both
// visible and cube-hidden fragments: a fixed painter order cannot represent it.
const box = new Mesh(geometry, material);
box.updateMatrixWorld(true);
const raycaster = new Raycaster();
let samples = 0;
let hidden = 0;
let visible = 0;
for (const projection of ["perspective", "orthographic"]) {
  for (const direction of [[0, 0, 1], [0, 0, -1], [1, -1, 1], [1, -1, -1], [1, 0, 0], [0, 1, 0], [-1, -1, 0.2], [-1, 1, -0.2]]) {
    const camera = projection === "perspective"
      ? new PerspectiveCamera(42, 1, 1, 2000)
      : new OrthographicCamera(-120, 120, 120, -120, 1, 2000);
    camera.position.copy(new Vector3(...direction).normalize().multiplyScalar(500));
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    for (let index = 0; index < 96; index++) {
      const angle = index * Math.PI * 2 / 96;
      const point = new Vector3(Math.cos(angle) * ORBIT_RING_RADIUS, Math.sin(angle) * ORBIT_RING_RADIUS, -VIEW_CUBE_HALF);
      const ndc = point.clone().project(camera);
      raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
      const hit = raycaster.intersectObject(box)[0];
      const isHidden = !!hit && hit.distance < point.distanceTo(raycaster.ray.origin) - 1e-7;
      if (isHidden) {
        assert.ok(hit.point.clone().project(camera).z < ndc.z);
        hidden++;
      } else visible++;
      samples++;
    }
  }
}
assert.ok(hidden > 0 && visible > hidden, "views must include both occluded and exposed compass fragments");
geometry.dispose();
material.dispose();
console.log(`PASS HUD-only depth prepass and actual Three render order; ${samples} perspective/orthographic compass samples (${hidden} hidden, ${visible} visible)`);
