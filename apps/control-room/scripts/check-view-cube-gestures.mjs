import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Interpret the production math without compiling a unit-test target.
const orientation = new URL("../src/modules/viewport-3d/orientation/", import.meta.url);
const source = readFileSync(new URL("cameraOrientation.ts", orientation), "utf8");
const math = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const distance = (camera) => Math.hypot(...camera.position.map((value, axis) => value - camera.target[axis]));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
let checks = 0;
for (const mode of ["camera", "object"]) {
  for (const position of [[3, 4, 5], [0, 0, 5], [0, 0, -5]]) {
    const initial = { position, target: [0, 0, 0], up: [0, 0, 1] };
    for (const [dx, dy] of [[50, 0], [0, 50], [30, -40]]) {
      const next = math.dragViewCubeCamera(initial, dx, dy, 0.01, mode);
      const fixed = mode === "camera" ? "position" : "target";
      assert.deepEqual(next[fixed], initial[fixed]);
      close(distance(next), distance(initial));
      close(Math.hypot(...next.up), 1);
      close(next.up.reduce((sum, value, axis) => sum + value * (next.position[axis] - next.target[axis]), 0), 0);
      assert.ok([...next.position, ...next.target, ...next.up].every(Number.isFinite));
      assert.notDeepEqual(next, initial);
      checks++;
    }
  }
}
const cube = readFileSync(new URL("ViewCube3DBox.tsx", orientation), "utf8");
assert.ok(cube.includes('event?.type === "pointerup"'));
assert.ok(cube.includes("event.pointerId !== gesture.pointerId"));
assert.ok(cube.includes('window.removeEventListener("blur", handleBlur)'));
assert.ok(cube.includes("completed.controls.enabled = completed.enabled"));
assert.ok(!cube.includes("onSnap(target.direction"));
console.log(`PASS ${checks} production camera rotations; release-only snap, pointer ownership, cleanup and controls restoration source guards`);

const eventsSource = readFileSync(new URL("../viewport3dEventManager.ts", orientation), "utf8");
const events = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(eventsSource).replace(/import\s*\{[\s\S]*?\}\s*from "@react-three\/fiber";/, "const createPointerEvents = () => ({ handlers: {} });")).toString("base64")}`);
for (const hit of [false, true]) {
  const state = { internal: { initialClick: [0, 0], initialHits: [] } };
  const store = { getState: () => state };
  const dispatch = { immediate: false };
  let dragging = false;
  let starts = 0;
  let selections = 0;
  const start = () => { dragging = true; starts++; state.internal.initialHits = hit ? [{}] : []; };
  const down = events.createViewport3DPointerDownHandler(store, start, dispatch);
  const click = events.createViewport3DClickSelectionHandler({ store, pointerDownHandler: start, pointerDownDispatch: dispatch, clickHandler: () => selections++ });
  const event = { currentTarget: { clientWidth: 800 }, offsetX: 720, offsetY: 80 };
  down(event);
  dragging = false;
  click(event);
  assert.equal(starts, 1);
  assert.equal(dragging, false);
  assert.equal(selections, hit ? 0 : 1);
  const outside = { ...event, offsetX: 300, offsetY: 300 };
  down(outside);
  assert.equal(starts, 1);
  click(outside);
  assert.equal(starts, 2);
}
console.log("PASS production HUD press/release/click does not restart gestures; ordinary selection keeps delayed raycasting");
