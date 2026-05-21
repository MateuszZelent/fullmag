# COMSOL-Style 3D Viewport HUD Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Fullmag `apps/control-room` 3D viewport closer to COMSOL's Graphics view by adding a physically scaled floor grid, vertical reference grids, tick marks, unit labels, and ribbon-controlled dimension-frame behavior without breaking the current one-canvas, demand-rendered viewport architecture.

**Architecture:** Keep the renderer domain-neutral and resource-first: the new grid is a viewport display overlay derived from `Viewport3DBounds`, camera state, and local viewport widget state, not from backend-specific FDM/FEM payloads. Replace the current single `gridHelper`/`axesHelper` layer with a dedicated dimension-frame model plus one R3F layer that owns its geometries/materials/textures and renders only on dirty changes. Use existing `viewport3dStore`, `viewport3dManifest`, and ribbon command patterns for display toggles; do not introduce new backend API fields in the first implementation slice.

**Tech Stack:** Next.js 16, React, React Three Fiber, Three.js `BufferGeometry`/`LineSegments`/`CanvasTexture`, Vitest, Playwright smoke scripts, Catppuccin `--fm-*` tokens, existing `fm-*` CSS class conventions.

---

## Success Criteria

The implementation is done only when all of these are true:

1. The 3D viewport can show a COMSOL-like reference cage: an XY floor grid plus two vertical grid planes selected from the current visible bounds.
2. Grid lines, tick marks, axis labels, and unit labels are physically meaningful and derived from `Viewport3DBounds`, not from viewport pixels or arbitrary solver layout.
3. The default view remains clean: the grid is helpful, not louder than geometry, field colors, mesh wireframes, ViewCube, or HSL reference widgets.
4. FDM, FEM, primitive-only authoring, and missing-session fallback all share the same dimension-frame code path.
5. The feature does not add continuous rendering. `VIEWPORT_3D_FRAMELOOP` remains `"demand"`, and grid/camera changes call `invalidate()` for bounded frames only.
6. All new CSS uses `fm-*` classes and `--fm-*` tokens; no raw color literals are added to React components.
7. Visual proof covers at least one nanoscale FDM fixture and one object/primitive scene, and the smoke explicitly checks nonblank canvas, WebGL context health, and visible scale-label pixels.

## Current Baseline

Files inspected before writing this plan:

- `docs/specs/frontend-v2/05-viewport-architecture.md`
- `docs/specs/frontend-v2/14-viewport-3d-module.md`
- `docs/specs/frontend-v2/15-viewport-2d-module.md`
- `docs/specs/frontend-v2/09-css-design-system.md`
- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- `apps/control-room/src/modules/viewport-3d/viewport3dStore.ts`
- `apps/control-room/src/modules/viewport-3d/manifest.ts`
- `apps/control-room/src/modules/viewport-3d/orientation/OrientationHudLayer.tsx`
- `apps/control-room/src/modules/viewport-3d/orientation/AxisLabelSprite.tsx`
- `apps/control-room/src/modules/viewport-3d/layers/viewport3DMaterialProfile.ts`
- `apps/control-room/src/design/styles/viewport-3d.css`
- `apps/control-room/scripts/smoke-viewport-3d.mjs`
- `apps/control-room/scripts/screenshot-viewport-3d.mjs`

Important observations:

- `Viewport3DScene.tsx` currently resolves a `Viewport3DGridSpec` and renders `AxesGridLayer`.
- `AxesGridLayer` uses one Three.js `gridHelper` rotated onto the XY plane at `bounds.center`, plus one `axesHelper`.
- There is no vertical grid plane, no floor anchoring to `bounds.min.z`, no tick-label model, and no unit-label model.
- `Viewport3DModule.tsx` renders a DOM HUD with pills for quantity, selection, domain summary, status, and diagnostics.
- `OrientationHudLayer.tsx` already anchors ViewCube and HSL widgets in the R3F scene and uses demand invalidation.
- `AxisLabelSprite.tsx` already creates text labels with `CanvasTexture`, which is the right local pattern for world-anchored scale labels.
- `viewport3dStore.ts` already owns transient viewport widget state such as projection, ViewCube visibility, HSL reference mode, visual profile, and antialias.
- `manifest.ts` already contributes viewport commands that mutate `viewport3dStore`.
- `ribbonContributions.tsx` already has a `view-dimension-frame` action, but today it only drives object/part bounds visibility; it does not control a COMSOL-like dimension grid.
- The viewport specs require one R3F canvas, domain-neutral render models, separate topology/buffer/style changes, explicit resource disposal, and demand rendering.

## Non-Goals

- Do not add a second canvas, split viewport, or mini-map.
- Do not add backend/OpenAPI fields in the first slice.
- Do not change FDM/FEM physics, field buffers, topology resources, or visualization resource contracts.
- Do not copy COMSOL toolbar chrome. This plan targets the in-scene measurement grid and scales.
- Do not make the grid a mesh topology visualization. It is a reference overlay, not solver data.
- Do not introduce a new UI primitive library or bespoke accessible menu controls.

## Visual Target

The target is not a pixel-for-pixel COMSOL clone. The Fullmag viewport should borrow these useful qualities:

- A dark, quiet viewport surface with crisp gray/white reference lines.
- A floor plane grid aligned with physical X/Y coordinates.
- One or two vertical planes so Z scale is readable without rotating the scene.
- Major ticks with numeric labels and a compact unit marker such as `nm`, `um`, or `mm`.
- Labels placed just outside the domain envelope so they do not cover magnetic geometry.
- Grid opacity lower than object/mesh edges, with labels brighter than minor grid lines.
- Orthographic projection should make scale reading especially clear; perspective should still preserve useful depth cues.

## File Structure

Create:

- `apps/control-room/src/modules/viewport-3d/layers/DimensionFrameLayer.tsx`
  - Owns the R3F rendering of grid planes, major lines, minor lines, tick marks, axis names, and unit labels.
  - Tracks and releases Three.js geometries/materials/textures through existing resource ownership patterns.

- `apps/control-room/src/modules/viewport-3d/layers/dimensionFrameModel.ts`
  - Pure model builder for physical units, nice tick steps, plane selection, line positions, tick label positions, and render density caps.
  - Contains no React and no R3F imports.

- `apps/control-room/src/modules/viewport-3d/layers/dimensionFrameModel.test.ts`
  - Unit tests for step selection, unit selection, plane anchoring, density limits, and label formatting.

- `apps/control-room/src/modules/viewport-3d/layers/DimensionFrameLayer.test.tsx`
  - Component-level tests that confirm the layer renders expected line and label groups without requiring backend resources.

Modify:

- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
  - Remove or retire the current `AxesGridLayer`.
  - Pass `bounds`, `cameraState`, `cameraProjection`, `colors`, `materialProfile`, and widget state into `DimensionFrameLayer`.

- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`
  - Replace `resolveViewport3DGridSpec` expectations with `dimensionFrameModel` expectations.
  - Preserve existing camera/orthographic/projection tests.

- `apps/control-room/src/modules/viewport-3d/layers/viewport3DMaterialProfile.ts`
  - Extend the material profile with dimension-frame line and label opacity settings.

- `apps/control-room/src/modules/viewport-3d/viewport3dTypes.ts`
  - Add token-derived color slots only if needed, for example `gridMinor`, `gridMajor`, `gridLabel`.

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DColors.ts`
  - Read any new color slots from tokens. Keep fallback to existing `wire`, `textSecondary`, and `background`.

- `apps/control-room/src/design/styles/theme.css`
  - Add semantic viewport grid tokens if reused in more than one place, for example `--fm-viewport-grid-minor`, `--fm-viewport-grid-major`, `--fm-viewport-grid-label`.

- `apps/control-room/src/modules/viewport-3d/viewport3dStore.ts`
  - Add local display state for dimension-frame mode and labels.

- `apps/control-room/src/modules/viewport-3d/manifest.ts`
  - Add command registry entries for dimension-frame mode and label visibility.

- `apps/control-room/src/modules/viewport-3d/manifest.test.ts`
  - Verify commands mutate local viewport state and do not require backend resources.

- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
  - Extend the existing `view-dimension-frame` action with shadcn-style radio/checkbox controls wired to command IDs.

- `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`
  - Verify the Frame menu exposes the new controls with stable command IDs.

- `apps/control-room/scripts/smoke-viewport-3d.mjs`
  - Add optional assertions that scale labels and dimension-grid pixels are visible after enabling the full frame mode.

- `apps/control-room/scripts/screenshot-viewport-3d.mjs`
  - Add a capture path that toggles the full dimension frame before comparing interactive/figure screenshots.

Do not modify:

- `apps/legacy_web`
- backend OpenAPI schema
- generated API types
- FDM/FEM topology or field decoding
- physics docs

## Data Model

Add these local viewport widget types:

```ts
export type Viewport3DDimensionFrameMode = "off" | "floor" | "cage";
export type Viewport3DDimensionFrameDensity = "auto" | "coarse" | "fine";
export type Viewport3DScaleUnitMode = "auto" | "nm" | "um" | "mm" | "m";

export interface Viewport3DWidgetState {
  dimensionFrameMode: Viewport3DDimensionFrameMode;
  dimensionFrameDensity: Viewport3DDimensionFrameDensity;
  scaleLabelsVisible: boolean;
  scaleUnitMode: Viewport3DScaleUnitMode;
}
```

Default values:

```ts
dimensionFrameMode: "floor",
dimensionFrameDensity: "auto",
scaleLabelsVisible: true,
scaleUnitMode: "auto",
```

Rationale:

- `floor` improves the default viewport without making it too busy.
- `cage` gives the COMSOL-like vertical planes the user asked for.
- `off` is needed for dense field views and screenshots where the grid would hide data.
- `auto` unit mode prevents users from thinking in meters for nanomagnetic problems.

## Dimension Frame Model Contract

Create a pure model with these public types:

```ts
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type {
  Viewport3DCameraProjection,
  Viewport3DCameraState,
} from "../viewport3dStore";

export interface DimensionFrameOptions {
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  density: "auto" | "coarse" | "fine";
  labelsVisible: boolean;
  mode: "off" | "floor" | "cage";
  unitMode: "auto" | "nm" | "um" | "mm" | "m";
}

export interface DimensionFrameModel {
  axisLabels: DimensionFrameLabel[];
  labelScaleWorld: number;
  majorLines: Float32Array;
  minorLines: Float32Array;
  mode: "off" | "floor" | "cage";
  planes: DimensionFramePlane[];
  tickLabels: DimensionFrameLabel[];
  unit: DimensionFrameUnit;
}

export interface DimensionFrameUnit {
  factor: number;
  id: "nm" | "um" | "mm" | "m";
  label: string;
}

export interface DimensionFrameLabel {
  colorRole: "axis" | "tick" | "unit";
  key: string;
  position: [number, number, number];
  text: string;
}
```

Implementation rules:

- Bounds fallback uses the existing micrometer-scale fallback only when session/domain bounds are missing.
- The model computes min/max from `bounds.center +/- bounds.size / 2`.
- `floor` mode renders only the XY plane at `zMin`.
- `cage` mode renders the XY floor plus two vertical walls chosen from camera direction:
  - if camera position is positive in X relative to target, choose the `xMin` wall; otherwise choose `xMax`;
  - if camera position is positive in Y relative to target, choose the `yMin` wall; otherwise choose `yMax`;
  - never draw both X walls or both Y walls in the first slice.
- Major step uses a `1, 2, 5, 10` nice-step sequence.
- `auto` density targets 5 to 8 major intervals across the largest visible span.
- `coarse` targets 4 to 5 major intervals.
- `fine` targets 8 to 12 major intervals.
- Minor subdivisions are 4 per major step for `coarse`/`auto`, and 5 per major step for `fine`.
- Hard cap total rendered line segments at 240 minor segments and 96 major/tick segments.
- Hard cap labels at 36 tick labels plus 6 axis/unit labels.
- Label values are formatted with no more than 4 significant digits and no trailing `.0`.

Unit selection:

```ts
// maxSpan is in meters.
if (maxSpan < 2e-6) return { id: "nm", factor: 1e9, label: "nm" };
if (maxSpan < 2e-3) return { id: "um", factor: 1e6, label: "um" };
if (maxSpan < 2) return { id: "mm", factor: 1e3, label: "mm" };
return { id: "m", factor: 1, label: "m" };
```

Use ASCII `um` in code. A later typography pass can choose a micro-meter symbol if the product wants it.

## Rendering Contract

`DimensionFrameLayer` should render:

- minor grid lines as low-opacity `lineSegments`,
- major grid lines as higher-opacity `lineSegments`,
- small tick marks outside the active bounds,
- tick labels as camera-facing sprites,
- axis labels `x`, `y`, `z` as camera-facing sprites near the positive ends,
- unit labels as camera-facing sprites near the active axes.

Use this structure:

```tsx
<group renderOrder={renderOrder}>
  <lineSegments geometry={minorGeometry} renderOrder={renderOrder}>
    <lineBasicMaterial
      color={minorColor}
      depthTest
      depthWrite={false}
      opacity={materialProfile.dimensionFrame.minorOpacity}
      toneMapped={false}
      transparent
    />
  </lineSegments>
  <lineSegments geometry={majorGeometry} renderOrder={renderOrder + 1}>
    <lineBasicMaterial
      color={majorColor}
      depthTest
      depthWrite={false}
      opacity={materialProfile.dimensionFrame.majorOpacity}
      toneMapped={false}
      transparent
    />
  </lineSegments>
  {model.tickLabels.map((label) => (
    <DimensionFrameLabelSprite
      key={label.key}
      color={labelColor}
      label={label.text}
      opacity={materialProfile.dimensionFrame.labelOpacity}
      outlineColor={outlineColor}
      position={label.position}
      scale={labelScale}
    />
  ))}
</group>
```

Material rules:

- `depthWrite=false` for all grid materials.
- `depthTest=true` for grid lines, so objects can occlude reference planes.
- `depthTest=false` for labels, because labels are placed outside the domain and should remain readable.
- `toneMapped=false` for lines and labels, matching existing helper material behavior.
- Opacity comes from `viewport3DMaterialProfile`, not hard-coded component values.

Color rules:

- Minor grid line color uses `colors.wire` with low opacity.
- Major grid line color uses `colors.textSecondary ?? colors.wire`.
- Label color uses `colors.textPrimary ?? colors.textSecondary ?? colors.wire`.
- If separate grid tokens are added, they must be read through `useViewport3DColors`.

Texture/resource rules:

- Reuse the `AxisLabelSprite` pattern, but create a separate `DimensionFrameLabelSprite` if smaller numeric typography is needed.
- Every `CanvasTexture` must be disposed in `useEffect` cleanup.
- `BufferGeometry` instances must be memoized by model signature and released through `Viewport3DResourceTracker`.
- Do not place generated textures in React state.

## Task 1: Model Tests For Units, Steps, Planes, And Caps

**Files:**

- Create: `apps/control-room/src/modules/viewport-3d/layers/dimensionFrameModel.ts`
- Create: `apps/control-room/src/modules/viewport-3d/layers/dimensionFrameModel.test.ts`

- [ ] **Step 1: Write failing tests for auto unit selection**

Add tests:

```ts
describe("resolveDimensionFrameUnit", () => {
  it("uses nm for nanoscale magnetic domains", () => {
    expect(resolveDimensionFrameUnit(250e-9, "auto")).toEqual({
      factor: 1e9,
      id: "nm",
      label: "nm",
    });
  });

  it("uses um for micrometer domains", () => {
    expect(resolveDimensionFrameUnit(12e-6, "auto").id).toBe("um");
  });

  it("uses mm for millimeter domains", () => {
    expect(resolveDimensionFrameUnit(0.4, "auto").id).toBe("mm");
  });

  it("honors explicit unit mode", () => {
    expect(resolveDimensionFrameUnit(100e-9, "um").id).toBe("um");
  });
});
```

- [ ] **Step 2: Run the model test and verify it fails**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/layers/dimensionFrameModel.test.ts
```

Expected: FAIL because `dimensionFrameModel.ts` exports do not exist yet.

- [ ] **Step 3: Implement unit selection and label formatting**

Implement:

```ts
export function resolveDimensionFrameUnit(
  maxSpanMeters: number,
  unitMode: Viewport3DScaleUnitMode,
): DimensionFrameUnit

export function formatDimensionFrameTickValue(
  valueMeters: number,
  unit: DimensionFrameUnit,
): string
```

Rules:

- `formatDimensionFrameTickValue(0, nm)` returns `"0"`.
- `formatDimensionFrameTickValue(125e-9, nm)` returns `"125"`.
- `formatDimensionFrameTickValue(1.25e-6, um)` returns `"1.25"`.
- Strip trailing zeros and a trailing decimal point.

- [ ] **Step 4: Add tests for major tick step selection**

Add tests:

```ts
describe("resolveDimensionFrameStep", () => {
  it("uses nice 1-2-5 steps", () => {
    expect(resolveDimensionFrameStep(100e-9, "auto")).toBe(20e-9);
    expect(resolveDimensionFrameStep(900e-9, "auto")).toBe(200e-9);
    expect(resolveDimensionFrameStep(3.2e-6, "coarse")).toBe(1e-6);
  });
});
```

- [ ] **Step 5: Implement nice-step selection**

Implement a deterministic `1, 2, 5, 10` step function that targets:

- `coarse`: 4 major intervals,
- `auto`: 6 major intervals,
- `fine`: 10 major intervals.

- [ ] **Step 6: Add tests for view-dependent cage plane selection**

Add tests that pass bounds centered at `[0, 0, 0]`, size `[100e-9, 80e-9, 20e-9]`, and camera positions in different quadrants.

Expected:

- camera at `[1, 1, 1]` chooses floor `zMin`, wall `xMin`, wall `yMin`;
- camera at `[-1, 1, 1]` chooses floor `zMin`, wall `xMax`, wall `yMin`;
- `mode: "floor"` returns only floor;
- `mode: "off"` returns no planes and empty line arrays.

- [ ] **Step 7: Implement `buildDimensionFrameModel`**

The model builder should:

- compute bounds min/max,
- select unit,
- select major step,
- build minor and major `Float32Array` line positions,
- place tick labels outside the active bounds,
- place axis/unit labels outside positive axis directions,
- enforce line and label caps,
- include a stable model signature field if useful for tests and memoization.

- [ ] **Step 8: Run tests until the model passes**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/layers/dimensionFrameModel.test.ts
```

Expected: PASS.

## Task 2: Render The Dimension Frame Layer

**Files:**

- Create: `apps/control-room/src/modules/viewport-3d/layers/DimensionFrameLayer.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/layers/DimensionFrameLayer.test.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/viewport3DMaterialProfile.ts`

- [ ] **Step 1: Extend material profile tests**

In `viewport3DMaterialProfile.test.ts`, assert the resolved material profile contains:

```ts
expect(profile.dimensionFrame).toMatchObject({
  labelOpacity: expect.any(Number),
  majorOpacity: expect.any(Number),
  minorOpacity: expect.any(Number),
});
```

Expected numeric ranges:

- `minorOpacity` between `0.12` and `0.28`;
- `majorOpacity` between `0.24` and `0.46`;
- `labelOpacity` between `0.72` and `1`.

- [ ] **Step 2: Run the material profile test and verify failure**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/layers/viewport3DMaterialProfile.test.ts
```

Expected: FAIL because `dimensionFrame` is missing.

- [ ] **Step 3: Add material profile fields**

Extend `Viewport3DMaterialProfile`:

```ts
dimensionFrame: {
  labelOpacity: number;
  majorOpacity: number;
  minorOpacity: number;
  tickOpacity: number;
};
```

Use slightly stronger values for `figure` and `capture` profiles than `interactive-lite`.

- [ ] **Step 4: Write a component test for hidden/off behavior**

In `DimensionFrameLayer.test.tsx`, render the layer with `mode="off"` and assert no line segments or sprites are emitted. Use the same shallow/component style as existing R3F layer tests in this folder.

- [ ] **Step 5: Write a component test for geometry ownership**

Assert that when a non-empty model is rendered:

- at least one geometry is tracked,
- cleanup releases tracked geometry,
- toggling model input produces a new geometry instead of mutating stale positions silently.

- [ ] **Step 6: Implement `DimensionFrameLayer`**

Implement props:

```ts
interface DimensionFrameLayerProps {
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  density: Viewport3DDimensionFrameDensity;
  labelsVisible: boolean;
  materialProfile: Viewport3DMaterialProfile;
  mode: Viewport3DDimensionFrameMode;
  tracker: Viewport3DResourceTracker;
  unitMode: Viewport3DScaleUnitMode;
}
```

Implementation requirements:

- Build model with `useMemo`.
- Build `BufferGeometry` for minor and major line arrays with `useMemo`.
- Track/release geometries through `tracker.track("geometry", geometry)` and `tracker.release("geometry", geometry)`.
- Render numeric labels with a small texture sprite component.
- Call `invalidate()` when geometry, labels, colors, or material profile changes.
- Return `null` when model mode is `off`.

- [ ] **Step 7: Run focused layer tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/layers/DimensionFrameLayer.test.tsx src/modules/viewport-3d/layers/viewport3DMaterialProfile.test.ts
```

Expected: PASS.

## Task 3: Replace The Current AxesGridLayer In The Scene

**Files:**

- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`

- [ ] **Step 1: Write tests that the old helper model is gone**

Update `Viewport3DScene.test.ts`:

- stop importing `resolveViewport3DGridSpec`,
- assert source does not contain `<gridHelper`,
- assert source imports `DimensionFrameLayer`,
- preserve orthographic camera tests exactly.

- [ ] **Step 2: Run the scene test and verify failure**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/layers/Viewport3DScene.test.ts
```

Expected: FAIL until the scene uses the new layer.

- [ ] **Step 3: Update scene props**

Add props to `Viewport3DSceneProps`:

```ts
dimensionFrameDensity: Viewport3DDimensionFrameDensity;
dimensionFrameMode: Viewport3DDimensionFrameMode;
scaleLabelsVisible: boolean;
scaleUnitMode: Viewport3DScaleUnitMode;
```

- [ ] **Step 4: Remove `AxesGridLayer`**

Remove:

- `GridHelper` and `AxesHelper` imports,
- `Viewport3DGridSpec`,
- `resolveViewport3DGridSpec`,
- `resolveViewport3DGridCellSize`,
- `niceGridStep` only if no remaining local use exists,
- `AxesGridLayer`,
- `applyHelperMaterialProfile`.

Keep camera clip and orthographic helpers unchanged.

- [ ] **Step 5: Mount `DimensionFrameLayer`**

Render it in the same relative scene position where `AxesGridLayer` lived, after selection/domain layers and before camera controls:

```tsx
<DimensionFrameLayer
  bounds={bounds}
  cameraProjection={cameraProjection}
  cameraState={cameraState}
  colors={colors}
  density={dimensionFrameDensity}
  labelsVisible={scaleLabelsVisible}
  materialProfile={materialProfile}
  mode={dimensionFrameMode}
  tracker={tracker}
  unitMode={scaleUnitMode}
/>
```

- [ ] **Step 6: Run scene tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/layers/Viewport3DScene.test.ts
```

Expected: PASS.

## Task 4: Add Local Store State And Commands

**Files:**

- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dStore.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dStore.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/manifest.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/manifest.test.ts`

- [ ] **Step 1: Write store tests for defaults and setters**

Add assertions:

```ts
expect(viewport3dStore.getSnapshot().widgets.dimensionFrameMode).toBe("floor");
expect(viewport3dStore.getSnapshot().widgets.dimensionFrameDensity).toBe("auto");
expect(viewport3dStore.getSnapshot().widgets.scaleLabelsVisible).toBe(true);
expect(viewport3dStore.getSnapshot().widgets.scaleUnitMode).toBe("auto");
```

Add setter tests:

- `setDimensionFrameMode("cage")`,
- `setDimensionFrameDensity("fine")`,
- `setScaleLabelsVisible(false)`,
- `setScaleUnitMode("nm")`.

- [ ] **Step 2: Run store tests and verify failure**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/viewport3dStore.test.ts
```

Expected: FAIL because fields and setters do not exist.

- [ ] **Step 3: Implement store fields and setters**

Add types and setter methods. Each setter must no-op if the value is unchanged, matching existing store behavior.

- [ ] **Step 4: Write command tests**

In `manifest.test.ts`, assert these command IDs exist and mutate local state:

```ts
viewport-3d.dimension-frame-off
viewport-3d.dimension-frame-floor
viewport-3d.dimension-frame-cage
viewport-3d.dimension-density-auto
viewport-3d.dimension-density-coarse
viewport-3d.dimension-density-fine
viewport-3d.scale-labels-toggle
viewport-3d.scale-unit-auto
viewport-3d.scale-unit-nm
viewport-3d.scale-unit-um
viewport-3d.scale-unit-mm
viewport-3d.scale-unit-m
```

Expected command behavior:

- mode and density commands are active only for their current value;
- label toggle is active when labels are visible;
- commands complete synchronously and do not call `visualizationSync.queuePatch`.

- [ ] **Step 5: Implement manifest commands**

Follow the existing `viewport-3d.hsl-reference-*` and profile command patterns.

- [ ] **Step 6: Run store and manifest tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/viewport3dStore.test.ts src/modules/viewport-3d/manifest.test.ts
```

Expected: PASS.

## Task 5: Wire Scene Props Through `Viewport3DModule`

**Files:**

- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.test.ts`

- [ ] **Step 1: Write test coverage for prop forwarding**

In `Viewport3DModule.test.ts`, add a source or render assertion matching the current test style:

- `dimensionFrameMode={commandState.widgets.dimensionFrameMode}`,
- `dimensionFrameDensity={commandState.widgets.dimensionFrameDensity}`,
- `scaleLabelsVisible={commandState.widgets.scaleLabelsVisible}`,
- `scaleUnitMode={commandState.widgets.scaleUnitMode}`.

- [ ] **Step 2: Run module test and verify failure**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/Viewport3DModule.test.ts
```

Expected: FAIL until props are forwarded.

- [ ] **Step 3: Forward widget props**

Pass the four new widget fields from `commandState.widgets` through `Viewport3DFrame` into `Viewport3DScene`.

- [ ] **Step 4: Run module test**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/Viewport3DModule.test.ts
```

Expected: PASS.

## Task 6: Extend The Ribbon Frame Menu

**Files:**

- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`

- [ ] **Step 1: Write ribbon tests for the Frame menu**

Extend the existing `view-dimension-frame` test to assert:

```ts
expect(frameAction).toMatchObject({
  id: "view-dimension-frame",
  label: "Frame",
});
```

Menu controls:

- radio group `frame:dimension-mode` with items `off`, `floor`, `cage`;
- radio group `frame:grid-density` with items `auto`, `coarse`, `fine`;
- checkbox `frame:scale-labels`;
- radio group `frame:scale-unit` with items `auto`, `nm`, `um`, `mm`, `m`;
- existing checkbox `frame:object-bounds` remains present.

- [ ] **Step 2: Run ribbon structure test and verify failure**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/ribbon/ribbonStructure.test.ts
```

Expected: FAIL until menu nodes are added.

- [ ] **Step 3: Implement the menu controls**

Use existing ribbon node shapes:

```ts
{
  type: "radio-group",
  id: "frame:dimension-mode",
  label: "Dimension grid",
  value: commandState.widgets.dimensionFrameMode,
  items: [
    { value: "floor", label: "Floor" },
    { value: "cage", label: "Floor + vertical" },
    { value: "off", label: "Off" },
  ],
}
```

Each item should route through the command registry with stable command IDs from Task 4.

Do not hand-roll callbacks in the ribbon if command registry wiring already supports `commandId` on item/radio entries. If the existing radio-group shape cannot attach command IDs per item, follow the closest current ribbon pattern used by HSL reference mode.

- [ ] **Step 4: Keep object bounds separate**

Do not reuse `frame:object-bounds` for dimension grid visibility. Object bounds are visualization target settings; the dimension frame is a viewport reference overlay.

- [ ] **Step 5: Run ribbon tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/ribbon/ribbonStructure.test.ts
```

Expected: PASS.

## Task 7: Add Optional Grid Color Tokens

**Files:**

- Modify only if needed: `apps/control-room/src/design/styles/theme.css`
- Modify only if needed: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DColors.ts`
- Modify only if needed: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DColors.test.ts`
- Modify only if needed: `apps/control-room/src/modules/viewport-3d/viewport3dTypes.ts`

- [ ] **Step 1: Decide whether existing colors are enough**

If `colors.wire`, `colors.textSecondary`, and `colors.textPrimary` produce readable results in dark and light themes, skip this task.

If not enough, add semantic tokens:

```css
--fm-viewport-grid-minor: color-mix(in srgb, var(--fm-text-muted) 55%, transparent);
--fm-viewport-grid-major: color-mix(in srgb, var(--fm-text-secondary) 68%, transparent);
--fm-viewport-grid-label: var(--fm-text-secondary);
```

Use token values in `theme.css` only. Components read tokens through `useViewport3DColors`.

- [ ] **Step 2: Add color-read tests**

Extend `useViewport3DColors.test.ts` to prove fallback behavior:

- with tokens present, `gridMinor`, `gridMajor`, `gridLabel` are read;
- without tokens, the returned colors remain non-null using existing fallbacks.

- [ ] **Step 3: Run color tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/hooks/useViewport3DColors.test.ts
```

Expected: PASS.

## Task 8: Visual Smoke And Screenshot Proof

**Files:**

- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Modify: `apps/control-room/scripts/screenshot-viewport-3d.mjs`
- Modify: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

- [ ] **Step 1: Add script-level tests before changing scripts**

In `viewportSmokeProjectionScript.test.ts` or a new script test, assert `smoke-viewport-3d.mjs` contains:

- `viewport-3d.dimension-frame-cage`,
- a scale-label locator or canvas-pixel sampling path for the dimension frame,
- no direct reliance on HUD text alone for canvas proof.

- [ ] **Step 2: Implement smoke helper to enable cage mode**

In `smoke-viewport-3d.mjs`, after the canvas is ready:

- execute the command through the UI/command surface if available,
- otherwise click the Frame menu and choose `Floor + vertical`,
- wait for a composite canvas change.

Expected smoke assertion:

- canvas remains nonblank,
- drawing buffer remains nonzero,
- no WebGL context loss,
- pixel sample changes after enabling cage mode,
- projection round-trip still passes.

- [ ] **Step 3: Add screenshot-gate variant**

In `screenshot-viewport-3d.mjs`, add a capture branch that enables the full dimension frame for at least the FDM fixture scene.

Expected:

- interactive and figure profiles still differ,
- FDM fixture still detects as FDM,
- dimension frame does not make screenshots blank or identical.

- [ ] **Step 4: Run script tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Expected: PASS.

## Task 9: Focused Test Gate

Run the focused unit/component tests:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/layers/dimensionFrameModel.test.ts src/modules/viewport-3d/layers/DimensionFrameLayer.test.tsx src/modules/viewport-3d/layers/Viewport3DScene.test.ts src/modules/viewport-3d/layers/viewport3DMaterialProfile.test.ts src/modules/viewport-3d/viewport3dStore.test.ts src/modules/viewport-3d/manifest.test.ts src/modules/viewport-3d/Viewport3DModule.test.ts src/modules/ribbon/ribbonStructure.test.ts src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Expected: PASS.

If this fails with the same error twice, stop and research 3 to 5 likely fixes before continuing.

## Task 10: Full Control-Room Quality Gate

Run:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room audit:idle-performance
```

Expected: all pass.

Notes:

- `typecheck` may rewrite `apps/control-room/next-env.d.ts`; if that change is incidental, restore it before finalizing.
- `audit:idle-performance` must still prove demand rendering. If dimension labels cause always-on frames, fix the layer before proceeding.

## Task 11: Browser Smoke Gate

Start or reuse the local control-room server, then run:

```bash
pnpm --dir apps/control-room smoke:viewport-3d
pnpm --dir apps/control-room screenshot:viewport-3d
```

Expected:

- smoke reports `Viewport 3D smoke passed`,
- screenshot gate reports `Viewport 3D screenshot gate passed`,
- no browser console errors,
- no `THREE.WebGLRenderer: Context Lost` during active startup,
- canvas drawing buffer is nonzero,
- projection round-trip still passes,
- enabling cage/floor grid produces visible canvas difference.

If a backend/session is unavailable, run the controlled smoke only with the established missing-session flag and classify the result as controlled canvas proof, not active-session acceptance:

```bash
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

## Task 12: Manual Visual Acceptance Checklist

Use a browser at `/workspace` with a representative FDM fixture, a primitive object scene, and a FEM/airbox scene.

Check:

- floor grid sits at the physical bottom of the bounds, not through the object's middle;
- vertical grid planes show Z scale clearly;
- numeric labels do not overlap the ViewCube, HSL reference sphere, DOM HUD, or method badge;
- grid opacity is lower than magnetic object wireframe and selection highlights;
- labels remain readable in dark and light themes;
- `off`, `floor`, and `cage` modes all work without changing solver resources;
- orthographic projection makes scale reading crisp;
- perspective projection keeps depth readable;
- camera orbit changes which vertical walls are shown only after a bounded dirty render;
- screenshot/capture includes the grid when enabled;
- no ordinary camera motion emits per-gesture visualization PATCH traffic beyond existing intentional camera-save behavior.

## Risk Register

| Risk | Cause | Mitigation |
|---|---|---|
| Grid becomes visual noise | Too many minor lines or labels | Hard caps, lower opacity, default `floor` not `cage` |
| Labels leak memory | Many `CanvasTexture` objects | Memoize by label/style and dispose on unmount/change |
| Idle render loop regresses | Label sprites or screen anchoring call `useFrame` unnecessarily | Do not use `useFrame`; rebuild only on bounds/camera/widget changes |
| Grid hides scientific data | Depth/opacity too aggressive | `depthTest=true` for lines, low opacity, labels outside bounds |
| UI state drifts from commands | Ribbon local callbacks bypass command registry | Add manifest commands and test command IDs |
| Scale labels lie for nanoscale domains | Unit selection or bounds conversion wrong | Pure tests for meters-to-display-unit conversion and nice steps |
| Screenshot smoke fooled by HUD | DOM HUD is nonblank while canvas is wrong | Sample canvas composite after enabling cage mode |

## Recommended Implementation Order

1. Build and test the pure `dimensionFrameModel`.
2. Add the R3F `DimensionFrameLayer`.
3. Replace `AxesGridLayer` in the scene.
4. Add local widget state and commands.
5. Wire ribbon controls.
6. Add visual smoke/screenshot assertions.
7. Run focused tests, full gates, and browser proof.

This order keeps the math isolated first, then integrates rendering, then exposes controls. It also makes failures easier to classify: math failure, R3F resource failure, command/ribbon failure, or browser visual failure.

## Execution Notes

- Keep all implementation code ASCII unless the file already uses non-ASCII.
- Use `apply_patch` for manual edits.
- Do not touch unrelated dirty files in the existing worktree.
- Do not update generated OpenAPI files for this slice.
- Do not re-enable React StrictMode.
- Do not change Next.js version.
- Keep `apps/control-room/app/globals.css` import-only.
- Preserve the existing viewport smoke distinction between controlled canvas proof and active-session acceptance.
