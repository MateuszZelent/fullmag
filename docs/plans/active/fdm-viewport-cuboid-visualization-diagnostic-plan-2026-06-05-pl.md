# FDM viewport cuboid visualization diagnostic plan

Status: diagnostic plan, no implementation changes.
Date: 2026-06-05
Updated: 2026-06-06 (code-verified corrections)

## Problem

FDM visualization in Control Room does not show the cubic mesh. The reported
symptom covers surface and wireframe modes: toggling them does not produce a
visible cuboid/grid representation for an FDM run.

This plan is intentionally diagnostic-only. It must establish which layer drops
the FDM visualization before any fix is made.

## Relevant Current Architecture

FDM does not use the FEM tetra topology rendering path.

Expected FDM path:

1. API publishes FDM domain metadata through
   `/v2/sessions/current/data/domain/meta`.
2. `adaptFdmDomainMeta()` converts `DomainMeta` into `FdmGridRenderDomain`.
3. `useViewport3DSceneModel()` builds `fdmSettings` and
   `fdmInstanceModel`.
4. `Viewport3DScene` mounts `FdmCuboidLayer` when
   `viewport3DFdmCuboidLayerEnabledFromBrowserConfig()` is true.
5. `FdmCuboidLayer` renders instanced `BoxGeometry` for surface and/or
   wireframe.

FEM mesh surface and wireframe use `TopologyMeshLayer` and mesh parts. FDM
cuboids use `FdmCuboidLayer`, so a FEM-working viewport does not prove the FDM
path is healthy.

### FDM airbox clarification

FDM does not have a separate airbox mesh. The entire FDM domain is one regular
grid. The role that the FEM `AirboxLayer` (topology-based, tetra mesh parts
with `role: "air"`) plays for FEM is replaced by `DomainBoxLayer` for FDM — a
simple wireframe `BoxGeometry` drawn around domain bounds. `AirboxLayer` is
FEM-only and returns nothing for FDM sessions because `topologyModel.airboxParts`
is empty. This is correct; no repair is needed for airbox visualization in FDM.

## Initial Hypotheses

Ordered by estimated probability (highest first).

### H1: API/domain metadata is missing or not FDM-shaped (HIGHEST probability)

`adaptFdmDomainMeta()` returns `null` if `DomainMeta.discretization !== "fdm"`
or `DomainMeta.grid` is missing. In that case `FdmCuboidLayer` receives no
domain and renders nothing.

**H1a: pre-solver null state.** The backend builds `grid` from
`snapshot.live_state.latest_step.grid`. If the solver has not yet executed
its first step, `live_state` is `None`, so `grid_shape` falls back to
`[0, 0, 0]`. The `fdm_grid` conditional
(`grid_shape.iter().any(|v| *v > 0)`) then evaluates to `false`, producing
`grid: null` in the API response. The frontend sees `meta.grid == null` and
returns `null` from `adaptFdmDomainMeta()`. This is the most common reason
for a blank FDM viewport on first load.

**H1b: artifact_layout metadata.** `fdm_grid_descriptor()` reads `origin`
and `spacing` from `snapshot.metadata["artifact_layout"]`. If `artifact_layout`
is missing or does not contain a `backend: "fdm"` entry, the function falls
back to `origin = [0, 0, 0]` and `spacing = [1, 1, 1]`. This produces
physically nonsensical 1 m × 1 m × 1 m cell dimensions instead of nanometers.
Cuboids will be rendered but at a wildly wrong scale, making nanoscale scene
objects invisible by comparison.

Evidence to collect:

```bash
curl -sS http://localhost:8081/v2/sessions/current/data/domain/meta
curl -sS http://localhost:8081/v2/sessions/current/status
```

Expected FDM evidence:

- `discretization: "fdm"`
- non-null `grid`
- `grid.shape` with all dimensions > 0
- `grid.spacing` with physically meaningful values (nanometer-scale for
  micromagnetics, not 1.0)
- `grid.origin` present
- `counts.cells > 0`
- active session/run references match the FDM script

If `grid` is null but `discretization` is `"fdm"`, H1a (pre-solver null state)
is confirmed.

If `grid.spacing` values are `[1, 1, 1]`, H1b (artifact_layout fallback) is
confirmed.

### H4: `FdmCuboidInstanceModel` is null or empty

`buildFdmCuboidInstanceModel()` returns null when:

- `domain` is null (cascade from H1),
- `domain.displayCellCount <= 0`,
- `domain.totalCells <= 0`,
- magnitude threshold filters out all sampled cells.

Evidence to collect:

- `DomainMeta.counts.cells`
- resolved display budget and display count
- current visual profile's `voxelMagnitudeThreshold`
- active field vector availability if threshold/topography are enabled

Expected for the current FDM permalloy example:

- positive total cell count,
- positive display cell count,
- no threshold-only filtering before field data is loaded.

### H2: FDM target settings are not receiving UI surface/wireframe changes (LOWER probability)

`useViewport3DSceneModel()` treats the FDM grid as an object target:

```text
target: { id: domainMeta.domain_id, kind: "object" }
```

**Code-verified context:** The ribbon surface/wireframe toggle uses
`patchDefaults("object", renderModePatch)` with `targetKinds: ["object",
"part"]` (see `ribbonCommands.ts:264`). Since the FDM domain target uses
`kind: "object"`, the defaults propagate correctly through
`resolveTargetVisualization()`. This means that the global ribbon toggle
*does* affect FDM visualization settings. A target mismatch is therefore
**less likely** than originally estimated, unless a per-target override
actively hides the FDM domain.

Evidence to collect:

```bash
curl -sS http://localhost:8081/v2/sessions/current/visualization/state
```

Check:

- global `layers.surface.visible`
- global `layers.wireframe.visible`
- `overrides` entries for FDM domain target
- whether any override uses `scope: "object"` and `scope_id` equal to
  `domainMeta.domain_id` **with `visible: false`**

### H3: `FdmCuboidLayer` is disabled by browser config

The layer is gated by:

```text
viewport3DFdmCuboidLayerEnabledFromBrowserConfig()
```

Evidence to collect in browser console:

```js
window.__FULLMAG_CONFIG__
```

Expected:

```text
disableViewport3DFdmCuboidLayer !== true
disableViewport3DSceneLayers !== true
disableViewport3D !== true
```

### H5: Camera/bounds make FDM geometry present but off-screen

`bounds` comes from topology, domain meta, universe, and primitive bounds. For
FDM it should resolve from domain meta or universe. If bounds are wrong, cuboids
may be rendered but outside the fitted camera volume.

Evidence to collect:

- `DomainMeta.bounds` or equivalent extent fields
- viewport diagnostics/HUD bounds summary if available
- screenshot with axes/bounds layers enabled
- camera reset result

### H6: Instanced upload/render is delayed or silently failing

`FdmCuboidLayer` uploads matrices in batches using `setTimeout(callback, 0)`.
If the model exists but upload does not complete, the instanced mesh exists
with default transforms and may be invisible or collapsed.

Additionally, the viewport uses `frameloop="demand"` (R3F demand rendering).
After each batch upload, `invalidate()` must be called to trigger a new frame.
If `invalidate()` is not invoked after the final batch, the viewport remains
on the previous frame and the new cuboids are never painted.

Evidence to collect in browser console:

- WebGL errors
- React console errors
- performance marks for `fullmag.viewport3d.uploadFdmCuboidMatrices`
- viewport diagnostics resource counts
- verify that `invalidate()` is called after the last upload batch

## Diagnostic Procedure

### Step 1: Start a known FDM UI run

Use the justfile FDM UI path, not the FEM permalloy alias:

```bash
just run-permalloy-box-relax-fdm-ui 3100
```

Record:

- API port,
- web port,
- loaded script path,
- requested backend,
- materialized backend plan.

Pass condition:

- log includes `_fdm.py`,
- requested backend is `fdm`,
- materialization reaches `Backend plan: fdm`.

### Step 2: Wait for solver first step

Before capturing API resources, confirm that the solver has executed at least
one step. Check the run log for a completed step entry. If the viewport is
blank but the solver has not started, H1a is automatically confirmed — the
viewport will populate once `live_state` becomes available.

### Step 3: Capture API resources

Run:

```bash
curl -sS http://localhost:8081/v2/sessions/current/data/domain/meta \
  > /tmp/fullmag-fdm-domain-meta.json
curl -sS http://localhost:8081/v2/sessions/current/visualization/state \
  > /tmp/fullmag-fdm-visualization-state.json
curl -sS http://localhost:8081/v2/sessions/current/status \
  > /tmp/fullmag-fdm-status.json
```

Check the domain meta response:

- If `grid` is `null` → H1a confirmed (pre-solver null state).
- If `grid.spacing` is `[1, 1, 1]` → H1b confirmed (artifact_layout fallback).
- If `grid` is present with correct spacing → proceed to Step 4.

Pass condition:

- domain meta proves FDM grid exists with physically meaningful dimensions,
- visualization state has surface/wireframe visibility that should make the
  FDM target visible,
- status identifies the same active session/run.

### Step 4: Browser-level evidence

Open `http://localhost:3100/workspace` and collect:

- console errors,
- `window.__FULLMAG_CONFIG__`,
- screenshot with surface enabled,
- screenshot with wireframe enabled,
- screenshot after camera reset.

Pass condition:

- no layer-disabling config,
- no WebGL context loss,
- screenshots prove whether geometry is absent, off-screen, or collapsed.

### Step 5: Target-setting trace

Compare IDs:

- `domainMeta.domain_id`
- scene object IDs from `/v2/sessions/current/model/scene`
- visualization overrides from visualization state
- explorer/inspector selected visualization target if available

The key question:

```text
Do the UI controls mutate the same target that useViewport3DSceneModel reads
for fdmSettings?
```

Given that ribbon defaults patch `kind: "object"` and FDM uses `kind: "object"`,
the defaults path is correct. The question reduces to: **is there a per-target
override that actively hides the FDM domain?**

If yes, H2 is confirmed.

### Step 6: Focused frontend model test

Add a failing test only after Step 1-5 identify the layer. Candidate test
surfaces:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
  for target/settings mapping.
- `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts`
  for cuboid instance rendering preconditions.
- `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.test.ts`
  for domain meta conversion.

The test must encode the exact failure:

- valid FDM domain,
- surface or wireframe enabled,
- resulting scene model must provide a non-null `fdmInstanceModel`,
- `FdmCuboidLayer` must not be disabled by target mismatch.

## Diagnostic Decision Table

Ordered by estimated probability.

| Finding | Root Cause Class | Probability | Next Plan |
|---|---|---|---|
| `grid` is null (solver not started) | H1a: pre-solver null state | HIGH | Document expected behavior; optionally show placeholder |
| `grid.spacing` is `[1, 1, 1]` | H1b: artifact_layout fallback | HIGH | Repair backend metadata publication |
| Domain meta not FDM-shaped | H1: API/runtime publication | HIGH | Repair API/session domain publication |
| Model null with valid domain/settings | H4: FDM instance model | MEDIUM | Repair adapter/model preconditions |
| Domain meta valid, FDM settings invisible | H2: frontend target mapping | LOW | Check for active per-target override |
| Layer disabled by config | H3: launch/config | LOW | Repair browser config injection/default |
| Model exists but canvas blank | H6: R3F/WebGL/render lifecycle | LOW | Repair layer upload/render/invalidate path |
| Model visible after camera reset only | H5: camera/bounds | LOW | Repair FDM bounds/camera fit |

## Aspects That Do Not Require Diagnosis

The following viewport layers are FEM-only and do not affect FDM visualization:

- `AirboxLayer` — requires FEM tetra topology with `role: "air"` mesh parts.
  FDM uses `DomainBoxLayer` (bounds wireframe) instead.
- `TopologyMeshLayer` — FEM tetra surface/wireframe.
- `ClipPlaneLayer` / cross-section — requires FEM topology; not available for
  FDM.
- `MeshSizeHighlightLayer` — FEM mesh quality overlay.

## Verification Required After Diagnosis

After diagnosis, any repair must be verified with:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d --test-timeout=20000
CONTROL_ROOM_URL=http://localhost:3100/workspace \
  CONTROL_ROOM_SCREENSHOT_SCENES=fdm \
  pnpm --dir apps/control-room screenshot:viewport-3d
```

The screenshot check must prove a nonblank canvas and visible FDM cuboid
surface or wireframe.
