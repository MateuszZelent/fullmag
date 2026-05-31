# R3F Camera Interaction Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make viewport rotation, pan, and zoom use the normal optimized Drei/R3F interaction path without app-level React state churn or custom half-control behavior during camera gestures.

**Architecture:** OrbitControls remains the only gesture implementation. Camera gesture state becomes a local Canvas-side mutable guard used only to prevent remote camera pose writes from fighting active controls. Render degradation moves to the official Drei/R3F performance path: `<OrbitControls regress />`, Canvas `performance`, and `<AdaptiveDpr />`; the app stops changing Canvas DPR and layer visibility from `cameraRegistry.interactionActive`.

**Tech Stack:** React 19, Next.js app router, `@react-three/fiber` demand rendering, `@react-three/drei` OrbitControls/AdaptiveDpr, `three-stdlib` OrbitControls, Vitest, existing viewport smoke scripts.

---

## Current-Code Comparison

| Gesture | three-stdlib path | Drei/R3F wrapper behavior | Current Fullmag extra work | Risk |
|---|---|---|---|---|
| Rotate drag | `handleMouseMoveRotate()` updates spherical deltas and calls `scope.update()` | Drei `change` listener calls `invalidate()`; our `onChange` only records `camera-control` | `onStart` flips `cameraRegistry.interactionActive`; app-level React recomputes scene model, Canvas DPR, and interaction layer settings. `onEnd` commits local camera after 200 ms. | Usually smooth because start/end happen once per drag and rotate math is cheap. |
| Pan drag | `handleMouseMovePan()` computes `panDelta`, calls `pan()`, then `scope.update()` | Same Drei `invalidate()` path | Same app-level `interactionActive` start/end churn as rotate. Pan also updates target, so any stale target sync is more visible. | Medium. React-side toggles can make pan feel sticky even when CPU is idle. |
| Wheel zoom | `onMouseWheel()` dispatches `start`, runs `handleMouseWheel()`, dispatches `end` for every wheel tick | Same Drei `invalidate()` path | Our debounce groups final commit, but `start` still flips global `interactionActive` at the beginning of a wheel burst. `zoomToCursor` is non-default and adds `getBoundingClientRect()`, unproject, projection updates, matrix updates, and retargeting in orthographic mode. | High. This is the path most likely to feel non-fluid. |

Key source facts:

- `@react-three/drei/core/OrbitControls.js` already calls `invalidate()` on `change`, and optionally calls `performance.regress()` when `regress` is true.
- `three-stdlib/controls/OrbitControls.js` defaults to `zoomToCursor = false`, `panSpeed = 1`, `zoomSpeed = 1`, `rotateSpeed = 1`, `dampingFactor = 0.05`.
- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx` currently sends `sceneProps.interactionActive` into `resolveViewport3DCanvasDpr()`, so camera start/end changes Canvas DPR through React props.
- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx` currently passes `interactionActive` into FDM, airbox, topology, and camera layers.
- `resolveCameraInteractionSettings()` hides wireframe/points/vectors and forces shader/bounds while `interactionActive` is true, so camera start/end changes render topology/material choices.

## File Structure

- Modify `apps/control-room/src/kernel/visualization/useCameraRegistry.ts`
  - Add a camera-only external-store hook so viewport scene data does not re-render on `interactionActive` flips.
- Modify `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
  - Stop reading full camera registry snapshots for render interaction state.
  - Return camera data only; remove camera-gesture `interactionActive` from scene props.
- Create `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraGesture.ts`
  - Local mutable gesture guard shared by camera controller and OrbitControls inside Canvas.
- Modify `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`
  - Use the local gesture guard instead of `interactionActive` props.
  - Enable Drei `regress`.
  - Restore OrbitControls pan/zoom defaults and make `zoomToCursor` false by default.
  - Commit camera once at gesture end without duplicating local store writes.
- Modify `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
  - Create the local camera gesture ref.
  - Stop passing `interactionActive` into render layers.
  - Mount `AdaptiveDpr`.
- Modify `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
  - Remove interaction-driven DPR logic.
  - Add Canvas `performance` configuration.
- Modify `apps/control-room/src/modules/viewport-3d/viewport3dVisualProfile.ts`
  - Make DPR profile-owned and stable; no camera interaction parameter.
- Modify tests:
  - `apps/control-room/src/kernel/visualization/useCameraRegistry.test.ts` or an existing camera registry test surface if hook tests already exist.
  - `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
  - `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`
  - `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`
  - `apps/control-room/src/modules/viewport-3d/Viewport3DModule.test.ts`
  - `apps/control-room/src/modules/viewport-3d/viewport3dVisualProfile.test.ts`
  - `apps/control-room/src/modules/viewport-3d/layers/viewport3DLayerSettings.test.ts`

---

### Task 1: Lock The Failing Contracts

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dVisualProfile.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.test.ts`

- [ ] **Step 1: Add a CameraControls contract test for official Drei performance regression**

Add this test to `CameraControls.test.ts` near the existing OrbitControls source-contract tests:

```ts
it("uses Drei performance regression instead of app-level interaction quality switches", () => {
  const source = readFileSync(
    new URL("./CameraControls.tsx", import.meta.url),
    "utf8",
  );
  const orbitControlsStart = source.indexOf("<OrbitControls");
  const orbitControlsBlock = source.slice(
    orbitControlsStart,
    source.indexOf("/>", orbitControlsStart),
  );

  expect(orbitControlsBlock).toContain("regress");
  expect(orbitControlsBlock).toContain("zoomToCursor={options.zoomToCursor}");
  expect(orbitControlsBlock).not.toContain("onStart={onCameraInteractionStart}");
  expect(orbitControlsBlock).not.toContain("onEnd={onCameraInteractionEnd}");
});
```

- [ ] **Step 2: Add a CameraControls options test for library-default pan/zoom**

Replace the current pan/zoom option expectations with:

```ts
expect(options.dampingFactor).toBe(0.05);
expect(options.panSpeed).toBe(1);
expect(options.rotateSpeed).toBe(1);
expect(options.zoomSpeed).toBe(1);
expect(options.zoomToCursor).toBe(false);
```

- [ ] **Step 3: Add a DPR contract test**

Replace the existing `drops DPR below 1 only during active camera interaction` test in `viewport3dVisualProfile.test.ts` with:

```ts
it("keeps DPR profile-owned during camera interaction", () => {
  const profile = getViewport3DVisualProfile("interactive");

  expect(
    resolveViewport3DCanvasDpr({
      devicePixelRatio: 2,
      profile,
    }),
  ).toBe(1.25);
});
```

- [ ] **Step 4: Add a scene-model contract test**

Add this source-level test to `useViewport3DSceneModel.test.ts` near the existing camera registry assertions:

```ts
it("subscribes to camera registry camera data without rendering on interactionActive flips", () => {
  const source = readFileSync(
    new URL("./useViewport3DSceneModel.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain("useCameraRegistryCamera()");
  expect(source).not.toContain("useCameraRegistrySnapshot()");
  expect(source).not.toContain("interactionActive: cameraView.interactionActive");
  expect(source).not.toContain("resolveCommittedViewport3DFieldVector({");
});
```

- [ ] **Step 5: Add a Viewport3DScene contract test**

Add this test to `Viewport3DScene.test.ts`:

```ts
it("keeps camera gesture state local to Canvas controls", () => {
  const source = readFileSync(
    new URL("./Viewport3DScene.tsx", import.meta.url),
    "utf8",
  );

  expect(source).toContain("createViewport3DCameraGestureRef()");
  expect(source).toContain("cameraGestureRef={cameraGestureRef}");
  expect(source).not.toContain("interactionActive={interactionActive}");
});
```

- [ ] **Step 6: Add a Viewport3DModule contract test for Canvas performance**

Add this test to `Viewport3DModule.test.ts`:

```ts
it("uses R3F Canvas performance instead of interaction-driven DPR props", () => {
  const source = readFileSync(
    new URL("./Viewport3DModule.tsx", import.meta.url),
    "utf8",
  );
  const canvasStart = source.indexOf("<Canvas");
  const canvasBlock = source.slice(canvasStart, source.indexOf(">", canvasStart));

  expect(source).toContain('import { AdaptiveDpr } from "@react-three/drei";');
  expect(canvasBlock).toContain("performance={VIEWPORT_3D_CANVAS_PERFORMANCE}");
  expect(source).toContain("<AdaptiveDpr />");
  expect(source).not.toContain("interactionActive: sceneProps.interactionActive");
});
```

- [ ] **Step 7: Run focused tests and confirm they fail**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/layers/CameraControls.test.ts src/modules/viewport-3d/viewport3dVisualProfile.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/layers/Viewport3DScene.test.ts src/modules/viewport-3d/Viewport3DModule.test.ts
```

Expected: FAIL on the new contract expectations.

---

### Task 2: Add A Local Canvas Camera Gesture Guard

**Files:**
- Create: `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraGesture.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`

- [ ] **Step 1: Create the local gesture guard**

Create `viewport3DCameraGesture.ts`:

```ts
export interface Viewport3DCameraGestureState {
  active: boolean;
}

export interface Viewport3DCameraGestureRef {
  current: Viewport3DCameraGestureState;
}

export function createViewport3DCameraGestureRef(): Viewport3DCameraGestureRef {
  return { current: { active: false } };
}

export function beginViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef,
): void {
  ref.current.active = true;
}

export function endViewport3DCameraGesture(
  ref: Viewport3DCameraGestureRef,
): void {
  ref.current.active = false;
}

export function viewport3DCameraGestureActive(
  ref: Viewport3DCameraGestureRef,
): boolean {
  return ref.current.active;
}
```

- [ ] **Step 2: Replace CameraController interaction prop with the local guard**

In `CameraControls.tsx`, import:

```ts
import {
  beginViewport3DCameraGesture,
  endViewport3DCameraGesture,
  viewport3DCameraGestureActive,
  type Viewport3DCameraGestureRef,
} from "./viewport3DCameraGesture";
```

Change `CameraController` props from:

```ts
  interactionActive,
```

to:

```ts
  cameraGestureRef,
```

and change the prop type from:

```ts
  interactionActive: boolean;
```

to:

```ts
  cameraGestureRef: Viewport3DCameraGestureRef;
```

Replace both guards:

```ts
if (interactionActive) return;
```

with:

```ts
if (viewport3DCameraGestureActive(cameraGestureRef)) return;
```

Update effect dependencies by removing `interactionActive` and adding `cameraGestureRef`.

- [ ] **Step 3: Replace OrbitCameraControls interaction prop with the local guard**

In `OrbitCameraControls`, replace the `interactionActive`, `onCameraInteractionStart`, and `onCameraInteractionEnd` props with:

```ts
  cameraGestureRef,
```

and type it as:

```ts
  cameraGestureRef: Viewport3DCameraGestureRef;
```

Replace the target-sync guard:

```ts
if (interactionActive) return;
```

with:

```ts
if (viewport3DCameraGestureActive(cameraGestureRef)) return;
```

Replace `handleStart` with:

```ts
const handleStart = useCallback(() => {
  if (endTimeoutRef.current !== null) {
    clearTimeout(endTimeoutRef.current);
    endTimeoutRef.current = null;
  }
  beginViewport3DCameraGesture(cameraGestureRef);
}, [cameraGestureRef]);
```

In `handleEnd`, after `commitOrbitCameraEnd(...)` and after orbit debug angle sync, replace:

```ts
onCameraInteractionEnd?.();
```

with:

```ts
endViewport3DCameraGesture(cameraGestureRef);
```

For orbit debug animation commit, replace the existing end callback with the same `endViewport3DCameraGesture(cameraGestureRef);`.

- [ ] **Step 4: Create the guard inside Viewport3DScene**

In `Viewport3DScene.tsx`, import:

```ts
import { createViewport3DCameraGestureRef } from "./viewport3DCameraGesture";
```

Inside `Viewport3DScene`, add:

```ts
const cameraGestureRef = useRef(createViewport3DCameraGestureRef()).current;
```

Pass it to both camera components:

```tsx
<CameraController
  bounds={bounds}
  cameraGestureRef={cameraGestureRef}
  cameraState={cameraState}
  fitRevision={fitRevision}
  onCameraChange={onCameraChange}
  resetCameraRevision={resetCameraRevision}
  tracker={tracker}
/>
```

```tsx
<OrbitCameraControls
  cameraGestureRef={cameraGestureRef}
  cameraOrthographicScale={cameraOrthographicScale}
  cameraProjection={cameraProjection}
  cameraState={cameraState}
  orbitDebugAngles={orbitDebugAngles}
  orbitDebugCommitRevision={orbitDebugCommitRevision}
  orbitDebugRevision={orbitDebugRevision}
  onCameraChange={onCameraChange}
  onOrbitDebugAnglesChange={onOrbitDebugAnglesChange}
  tracker={tracker}
/>
```

- [ ] **Step 5: Run CameraControls and Viewport3DScene tests**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/layers/CameraControls.test.ts src/modules/viewport-3d/layers/Viewport3DScene.test.ts
```

Expected: Camera gesture guard tests pass; remaining performance/DPR tests still fail until later tasks.

---

### Task 3: Stop Propagating Camera Interaction Into Scene Rendering

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/useCameraRegistry.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/TopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/viewport3DLayerSettings.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/viewport3DLayerSettings.test.ts`

- [ ] **Step 1: Add a camera-only registry hook**

In `useCameraRegistry.ts`, add:

```ts
export function useCameraRegistryCamera(): CameraRegistrySnapshot["camera"] {
  const cameraRegistry = useCameraRegistryController();
  const subscribe = useCallback(
    (onStoreChange: () => void) => cameraRegistry.subscribe(onStoreChange),
    [cameraRegistry],
  );

  return useSyncExternalStore(
    subscribe,
    () => cameraRegistry.getSnapshot().camera,
    () => cameraRegistry.getSnapshot().camera,
  );
}
```

This hook intentionally returns the `camera` object, not the whole snapshot. `beginInteraction()` and `endInteraction()` notify subscribers, but the camera object identity stays unchanged, so React does not re-render the viewport scene model for pure interaction-active flips.

- [ ] **Step 2: Make `resolveViewport3DSceneCameraView` camera-only**

In `useViewport3DSceneModel.ts`, change the import:

```ts
import { useCameraRegistryCamera } from "@/kernel/visualization/useCameraRegistry";
```

Remove `CameraRegistrySnapshot` from this file.

Change `resolveViewport3DSceneCameraView` to:

```ts
export function resolveViewport3DSceneCameraView({
  cameraRegistryCamera,
  commandState,
}: {
  cameraRegistryCamera: VisualizationStateResource["camera"];
  commandState: Pick<Viewport3DCommandState, "camera" | "widgets">;
}): {
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraResource: VisualizationStateResource["camera"];
  cameraState: Viewport3DCameraState;
} {
  return {
    cameraOrthographicScale: commandState.widgets.cameraOrthographicScale,
    cameraProjection: commandState.widgets.cameraProjection,
    cameraResource: cameraRegistryCamera,
    cameraState: commandState.camera,
  };
}
```

Update the call site:

```ts
const cameraRegistryCamera = useCameraRegistryCamera();
const cameraView = resolveViewport3DSceneCameraView({
  cameraRegistryCamera,
  commandState,
});
```

- [ ] **Step 3: Remove camera interaction from field-vector commit**

Delete `resolveCommittedViewport3DFieldVector()` and its tests.

Replace:

```ts
const [committedFieldVectorStore] = useState(
  () => createCommittedFieldVectorStore(fieldVector.data),
);
const committedFieldVector = useSyncExternalStore(
  committedFieldVectorStore.subscribe,
  committedFieldVectorStore.getSnapshot,
  committedFieldVectorStore.getSnapshot,
);
useEffect(() => {
  committedFieldVectorStore.set(
    resolveCommittedViewport3DFieldVector({
      current: committedFieldVectorStore.getSnapshot(),
      interactionActive: cameraView.interactionActive,
      next: fieldVector.data,
    }),
  );
}, [
  cameraView.interactionActive,
  committedFieldVectorStore,
  fieldVector.data,
]);
```

with:

```ts
const committedFieldVector = fieldVector.data ?? null;
```

The earlier binary decode freeze was compensating for incorrect realtime invalidations. Gesture smoothness must not depend on a React subscription to camera activity. Heavy resource deferral should be handled by resource scheduling, not by viewport render props.

- [ ] **Step 4: Remove `interactionActive` from returned scene props**

In the return object from `useViewport3DSceneModel`, delete:

```ts
interactionActive: cameraView.interactionActive,
```

In `Viewport3DSceneProps`, delete:

```ts
interactionActive: boolean;
```

In `Viewport3DScene`, remove `interactionActive` from destructuring.

- [ ] **Step 5: Remove render-layer interaction rewrites**

In `Viewport3DScene.tsx`, remove `interactionActive={interactionActive}` from:

- `FdmCuboidLayer`
- `AirboxLayer`
- `TopologyMeshLayer`
- `CameraController`
- `OrbitCameraControls`

In `FdmCuboidLayer.tsx`, `BoundsLayers.tsx`, `TopologyMeshLayer.tsx`, `MeshPartLayer.tsx`, and `FallbackTopologyMeshLayer.tsx`, remove the `interactionActive` props and replace:

```ts
const renderSettings = useMemo(
  () => resolveCameraInteractionSettings(settings, interactionActive),
  [interactionActive, settings],
);
```

with:

```ts
const renderSettings = settings;
```

For fallback settings use:

```ts
const renderSettings = fallbackSettings;
```

Delete `resolveCameraInteractionSettings()` from `viewport3DLayerSettings.ts` and remove its tests from `viewport3DLayerSettings.test.ts`.

- [ ] **Step 6: Run scene-model and layer tests**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/layers/Viewport3DScene.test.ts src/modules/viewport-3d/layers/viewport3DLayerSettings.test.ts src/modules/viewport-3d/layers/BoundsLayers.test.tsx
```

Expected: PASS. Any failing snapshot/source tests should be updated only to match the new contract: camera gestures do not rewrite render layer settings.

---

### Task 4: Move Adaptive Quality To Drei/R3F

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dVisualProfile.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dVisualProfile.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`

- [ ] **Step 1: Make DPR stable and profile-owned**

In `viewport3dVisualProfile.ts`, delete:

```ts
const VIEWPORT_3D_INTERACTION_DPR_CAP = 0.75;
```

Change `resolveViewport3DCanvasDpr` to:

```ts
export function resolveViewport3DCanvasDpr({
  devicePixelRatio,
  profile,
}: {
  devicePixelRatio: number;
  profile: Viewport3DVisualProfile;
}): number {
  const safeRatio = Number.isFinite(devicePixelRatio)
    ? Math.max(1, devicePixelRatio)
    : 1;
  return Math.min(safeRatio, profile.dprCap);
}
```

- [ ] **Step 2: Add R3F Canvas performance config and AdaptiveDpr**

In `Viewport3DModule.tsx`, add:

```ts
import { AdaptiveDpr } from "@react-three/drei";
```

Near `Viewport3DFrame`, add:

```ts
const VIEWPORT_3D_CANVAS_PERFORMANCE = {
  debounce: 250,
  max: 1,
  min: 0.5,
} as const;
```

Change the DPR call to:

```ts
const canvasDpr = resolveViewport3DCanvasDpr({
  devicePixelRatio:
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
  profile: visualProfile,
});
```

Add this prop to `<Canvas>`:

```tsx
performance={VIEWPORT_3D_CANVAS_PERFORMANCE}
```

Mount `AdaptiveDpr` as the first Canvas child:

```tsx
<AdaptiveDpr />
<Viewport3DScene
  {...sceneProps}
  colors={colors}
  orbitDebugAngles={orbitDebugAngles}
  orbitDebugCommitRevision={orbitDebugCommitRevision}
  orbitDebugRevision={orbitDebugRevision}
  onOrbitDebugAnglesChange={syncOrbitDebugAngles}
  onVisualizationFrameCommitted={onVisualizationFrameCommitted}
  visualProfileId={visualProfile.id}
/>
```

- [ ] **Step 3: Enable Drei regress on OrbitControls**

In `CameraControls.tsx`, extend the options interface:

```ts
  zoomToCursor: boolean;
```

Change `VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS` to:

```ts
const VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS = {
  dampingFactor: 0.05,
  enableDamping: true,
  enablePan: true,
  enableZoom: true,
  mouseButtons: {
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  },
  panSpeed: 1,
  rotateSpeed: 1,
  screenSpacePanning: true,
  zoomSpeed: 1,
  zoomToCursor: false,
} satisfies Viewport3DCameraInteractionOptions;
```

Change the `<OrbitControls>` props to include:

```tsx
regress
zoomToCursor={options.zoomToCursor}
```

Keep `onChange={recordOrbitControlFrame}` because it only records diagnostics and Drei already performs `invalidate()`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/layers/CameraControls.test.ts src/modules/viewport-3d/viewport3dVisualProfile.test.ts src/modules/viewport-3d/Viewport3DModule.test.ts
```

Expected: PASS.

---

### Task 5: Remove Duplicate End-Commit Store Writes

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`

- [ ] **Step 1: Make OrbitControls end commit delegate store writes to `onCameraChange`**

In `handleEnd`, change:

```ts
commitOrbitCameraEnd({
  cameraPosition: tuple3(camera.position.toArray()),
  cameraUp: tuple3(camera.up.toArray()),
  controlTarget: target,
  onCameraChange,
  orthographicScale,
  projection: cameraProjection === "orthographic" ? "orthographic" : undefined,
});
```

to:

```ts
commitOrbitCameraEnd({
  cameraPosition: tuple3(camera.position.toArray()),
  cameraUp: tuple3(camera.up.toArray()),
  controlTarget: target,
  onCameraChange,
  orthographicScale,
  projection: cameraProjection === "orthographic" ? "orthographic" : undefined,
  syncStore: false,
});
```

Apply the same `syncStore: false` to the orbit-debug commit path.

- [ ] **Step 2: Update the existing commit test**

In `CameraControls.test.ts`, keep the existing direct `commitOrbitCameraEnd` tests for `syncStore: true`.

Add this test for the production handler contract:

```ts
it("lets OrbitControls end commits write through onCameraChange once", () => {
  const source = readFileSync(
    new URL("./CameraControls.tsx", import.meta.url),
    "utf8",
  );
  const handleEndBlock = source.slice(
    source.indexOf("const handleEnd = useCallback"),
    source.indexOf("const handleEndRef = useRef"),
  );

  expect(handleEndBlock).toContain("syncStore: false");
});
```

- [ ] **Step 3: Run CameraControls tests**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/layers/CameraControls.test.ts
```

Expected: PASS.

---

### Task 6: Verify No Camera Gesture Starts Background Resource Work

**Files:**
- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Modify: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

- [ ] **Step 1: Extend the smoke script to sample camera gesture network activity**

In `smoke-viewport-3d.mjs`, add a helper that clears the browser diagnostics buffer, performs gestures, then asserts no data/model/visualization-state fetches were sent by camera movement:

```js
async function assertCameraGestureDoesNotFetch(page, gestureName, gesture) {
  await page.evaluate(() => {
    window.__FULLMAG_DIAGNOSTICS__?.clear?.();
  });

  await gesture();

  const entries = await page.evaluate(() =>
    window.__FULLMAG_DIAGNOSTICS__?.entries?.() ?? [],
  );
  const unexpected = entries.filter((entry) => {
    if (entry.channel !== "http" || entry.direction !== "tx") return false;
    return [
      "/v2/sessions/current/data/",
      "/v2/sessions/current/model/",
      "/v2/sessions/current/meshing/",
      "/v2/sessions/current/visualization/state",
    ].some((prefix) => entry.path?.startsWith(prefix));
  });

  if (unexpected.length > 0) {
    throw new Error(
      `${gestureName} triggered unexpected resource work: ${unexpected
        .map((entry) => `${entry.method} ${entry.path}`)
        .join(", ")}`,
    );
  }
}
```

Call it for:

```js
await assertCameraGestureDoesNotFetch(page, "orbit rotate", async () => {
  await page.mouse.move(centerX, centerY);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(centerX + 160, centerY + 40, { steps: 12 });
  await page.mouse.up({ button: "left" });
});

await assertCameraGestureDoesNotFetch(page, "orbit pan", async () => {
  await page.mouse.move(centerX, centerY);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centerX + 120, centerY + 80, { steps: 12 });
  await page.mouse.up({ button: "right" });
});

await assertCameraGestureDoesNotFetch(page, "orbit zoom", async () => {
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(300);
});
```

If the diagnostics API uses different runtime names, adapt only the `clear`/`entries` accessors to the actual existing diagnostics object. Keep the asserted path prefixes exactly as above.

- [ ] **Step 2: Add a source contract for the smoke helper**

In `viewportSmokeProjectionScript.test.ts`, add:

```ts
it("asserts camera gestures do not issue data/model/visualization fetches", () => {
  const source = readFileSync(
    new URL("../../scripts/smoke-viewport-3d.mjs", import.meta.url),
    "utf8",
  );

  expect(source).toContain("assertCameraGestureDoesNotFetch");
  expect(source).toContain('"/v2/sessions/current/data/"');
  expect(source).toContain('"/v2/sessions/current/model/"');
  expect(source).toContain('"/v2/sessions/current/meshing/"');
  expect(source).toContain('"/v2/sessions/current/visualization/state"');
  expect(source).toContain('"orbit rotate"');
  expect(source).toContain('"orbit pan"');
  expect(source).toContain('"orbit zoom"');
});
```

- [ ] **Step 3: Run smoke-script tests**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Expected: PASS.

---

### Task 7: Full Verification

**Files:**
- No additional files.

- [ ] **Step 1: Run focused viewport suite**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/layers/CameraControls.test.ts src/modules/viewport-3d/layers/Viewport3DScene.test.ts src/modules/viewport-3d/Viewport3DModule.test.ts src/modules/viewport-3d/viewport3dVisualProfile.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/layers/viewport3DLayerSettings.test.ts src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --dir apps/control-room typecheck
```

Expected: PASS.

- [ ] **Step 3: Run viewport smoke against the local app**

With the dev server running on the active local URL, run:

```bash
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Expected: PASS. During manual verification, rotate, pan, and zoom should not produce `GET /data`, `GET /model`, `GET /meshing`, or `PATCH /visualization/state` entries. `POST /visualization/client-acks` may still appear after real visualization resource commits; it is not a camera-control fetch.

- [ ] **Step 4: Manual acceptance criteria**

Accept only if all are true:

- Idle CPU stays near the previously fixed 0 percent behavior.
- Rotate remains smooth.
- Right-button pan does not hitch at gesture start.
- Wheel zoom does not hitch on the first tick and does not feel sticky between ticks.
- Thread Manager shows no binary decode samples caused by camera gestures.
- React profiler does not show full `Viewport3DModule` updates on every raw OrbitControls change.

---

## Self-Review

Spec coverage:

- R3F/Drei-native implementation: Task 4 uses `regress`, Canvas `performance`, and `AdaptiveDpr`.
- No custom half-control implementation: Tasks 2 and 4 keep OrbitControls as the only gesture engine and remove `zoomToCursor` from the default path.
- Pan/zoom extra operations: Current-code table identifies the exact extra paths; Task 6 verifies gestures do not trigger resource/network work.
- React/render churn: Tasks 2 and 3 remove camera gesture state from app-level scene rendering.

Placeholder scan:

- No task contains "TBD", "TODO", "implement later", or unspecified error handling.
- The only adaptation note is limited to matching the actual diagnostics object accessor in the existing smoke runtime; the asserted camera-resource contract is explicit.

Type consistency:

- `Viewport3DCameraGestureRef` is defined before it is used.
- `useCameraRegistryCamera()` returns `CameraRegistrySnapshot["camera"]`, matching existing `VisualizationStateResource["camera"]` call sites.
- `resolveViewport3DCanvasDpr()` call sites match the new two-argument object shape.
