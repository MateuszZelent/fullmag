# FDM viewport cuboid visualization repair plan

Status: repair plan derived from the diagnostic plan. Do not implement before
capturing the diagnostic evidence.
Date: 2026-06-05
Updated: 2026-06-06 (code-verified corrections, reordered by probability)

Diagnostic source:

- `docs/plans/active/fdm-viewport-cuboid-visualization-diagnostic-plan-2026-06-05-pl.md`

## Goal

Make FDM cubic-grid visualization behave like a first-class viewport target:

- surface mode shows FDM cuboids,
- wireframe mode shows FDM cuboid edges,
- visibility/opacity/vector controls apply to FDM consistently,
- camera reset frames the FDM domain,
- FEM mesh visualization remains unchanged.

## Non-Goals

- Do not replace FDM cuboids with tetra topology.
- Do not change solver physics, FDM grid generation, or artifacts.
- Do not change FEM mesh/airbox rendering.
- Do not add a second viewport tree for FDM.
- Do not add a separate FDM airbox layer. FDM uses `DomainBoxLayer` (bounds
  wireframe) for the domain boundary — this is correct and sufficient.

## Preferred Repair: H1 — API/domain metadata (HIGHEST probability)

Code analysis shows this is the most likely root cause. The backend builds the
FDM `grid` descriptor from `snapshot.live_state.latest_step.grid`. Two
sub-cases produce a broken or empty viewport.

### H1a: Pre-solver null state

If the solver has not executed its first step, `live_state` is `None` and
`grid_shape` falls back to `[0, 0, 0]`. The API returns `grid: null` and the
frontend `adaptFdmDomainMeta()` returns `null`.

Candidate repairs (pick one based on product intent):

1. **Accept blank viewport before first step.** Document this as expected
   behavior. Optionally show a placeholder message ("Waiting for solver to
   produce first step…") in the viewport or status bar.

2. **Populate grid from problem definition before solver starts.** Derive
   `grid_shape`, `spacing`, and `origin` from the `ProblemIR` FDM grid
   definition or the planning output, so that the viewport shows the grid
   structure even before the solver runs. This requires the planner/session
   to write initial grid metadata into `live_state` or a separate metadata
   field.

Candidate backend surfaces:

- `crates/fullmag-api/src/router_v2/handlers/data/domain.rs` —
  `fdm_grid_descriptor()` and the `grid_shape` resolution.
- session initialization code that creates `live_state`.
- planner output that produces grid dimensions.

### H1b: artifact_layout metadata fallback

`fdm_grid_descriptor()` reads `origin` and `spacing` from
`snapshot.metadata["artifact_layout"]`. If `artifact_layout` is missing or
does not contain `backend: "fdm"`, the function falls back to
`origin = [0, 0, 0]` and `spacing = [1, 1, 1]` — producing 1 m cells
instead of nanometers.

Candidate repairs:

1. Ensure the FDM solver or session planner always writes `artifact_layout`
   with correct `cell_size` and `origin` before the first step.
2. If `artifact_layout` is missing, derive spacing from `ProblemIR` FDM grid
   definition instead of using the `[1, 1, 1]` fallback.

Candidate backend surfaces:

- `crates/fullmag-api/src/router_v2/handlers/data/domain.rs` —
  `fdm_grid_descriptor()` spacing/origin resolution.
- FDM solver artifact layout publication.
- Session metadata initialization.

### Required contract after H1 repair

- `discretization: "fdm"`
- populated `grid.shape` with all dimensions > 0
- populated `grid.spacing` with physically meaningful values (nanometer-scale)
- populated `grid.origin`
- positive `counts.cells`
- bounds consistent with the FDM universe/grid

### Tests

- API route test for `/v2/sessions/current/data/domain/meta` with FDM session.
- API route test that `grid.spacing` is not `[1, 1, 1]` for a micromagnetic
  FDM session.
- Frontend `viewport3dDomainAdapter.test.ts` fixture matching that payload.
- Frontend test that `adaptFdmDomainMeta()` returns `null` when `grid` is
  `null` (pre-solver state is handled gracefully).

### Verification

```bash
curl -sS http://localhost:8081/v2/sessions/current/data/domain/meta
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewport3dDomainAdapter.test.ts
```

## Repair If H4 Is Confirmed

If `FdmCuboidInstanceModel` is null despite valid domain/settings, fix model
preconditions. This is often a cascade from H1 — fixing H1 fixes H4.

Candidate fixes:

- correct display cell count calculation in `adaptFdmDomainMeta()`;
- prevent magnitude threshold from filtering all cells before field data is
  available;
- ensure field point count matches FDM cell count when threshold/topography are
  active.

Tests:

- `viewport3dDomainAdapter.test.ts` for display count;
- `FdmCuboidLayer.test.ts` for threshold-without-field fallback;
- `useViewport3DSceneModel.test.ts` for `fdmInstanceModelEnabled`.

## Repair If H2 Is Confirmed (LOWER probability than originally estimated)

Code analysis shows that the ribbon surface/wireframe toggle uses
`patchDefaults("object", renderModePatch)` with `targetKinds: ["object",
"part"]`. The FDM domain target uses `kind: "object"`, so defaults propagate
correctly through `resolveTargetVisualization()`. A full target mismatch is
therefore unlikely.

The remaining H2 scenario: a **per-target visualization override** actively
hides the FDM domain (e.g., `scope: "object"`, `scope_id:
domainMeta.domain_id`, `visible: false`).

### Contract Change (if needed)

A `targetForFdmDomain()` helper in `viewport3DTargets.ts` is still a useful
refactoring to centralize the FDM target, but it is unlikely to fix the core
visibility issue.

```text
kind: "object"
id: domainMeta.domain_id
label: domainMeta.domain_id
```

### Required Tests

Add or update focused tests so this cannot regress:

1. `viewport3DTargets.test.ts`
   - FDM domain target helper returns stable `{ kind: "object", id:
     domainMeta.domain_id }`.
   - It does not fall back to FEM mesh part IDs.

2. `useViewport3DSceneModel.test.ts`
   - valid FDM domain plus global surface visibility results in FDM settings
     with `visible=true`, `shaderVisible=true`.
   - valid FDM domain plus global wireframe visibility results in
     `wireframeVisible=true`.
   - target override for the FDM domain affects `fdmSettings`.

3. `FdmCuboidLayer.test.ts`
   - visible surface settings do not return null when model exists.
   - visible wireframe settings do not return null when shader is hidden.

### Implementation Steps

1. Add `targetForFdmDomain()` or equivalent central helper.
2. Replace ad hoc FDM target construction in `useViewport3DSceneModel()`.
3. Wire the same helper into the UI surface that creates object visualization
   controls for FDM, if diagnostic evidence shows it currently uses another ID.
4. Keep `FdmCuboidLayer` rendering logic unchanged unless tests prove the layer
   itself is the failing point.
5. Run targeted tests.
6. Run browser screenshot/smoke against a live FDM session.

## Repair If H3 Is Confirmed

If the browser config disables FDM cuboids, repair launch/config defaults.

Candidate surfaces:

- config injection in the API/static shell
- dev launcher config for Control Room
- `apps/control-room/src/kernel/browserFullmagConfig.ts`

Rule:

```text
disableViewport3DFdmCuboidLayer must default to false.
```

Tests:

- focused browser config test if one exists,
- source-level regression in `FdmCuboidLayer.test.ts` or scene test proving the
  FDM layer branch is gated only by that explicit disable flag.

## Repair If H5 Is Confirmed

If cuboids exist but camera fit is wrong, repair FDM bounds.

Candidate surfaces:

- `resolveDomainBounds()`
- `adaptFdmDomainMeta()`
- API domain meta bounds
- camera fit inputs in `useViewport3DSceneModel()`

Note: FDM micromagnetic grids have bounds in **nanometer** scale (e.g.,
`[4e-9, 4e-9, 3e-9]`). Camera near/far clipping planes must accommodate
this. The current implementation uses `far: Math.max(fit.far, ..., 1e-3)`
which should be sufficient, but verify during diagnosis.

Tests:

- adapter test with FDM grid dimensions and origin;
- camera fit test if the existing surface supports it.

Browser verification must include camera reset before/after screenshots.

## Repair If H6 Is Confirmed

If model exists but instanced upload/render fails, repair `FdmCuboidLayer`.

Candidate fixes:

- ensure surface/wireframe refs both receive matrix uploads after mount;
- ensure toggling from surface to wireframe retriggers matrix upload;
- ensure material opacity/depth settings do not hide wireframe behind the
  surface;
- record and invalidate dirty frame after final batch;
- **verify `invalidate()` is called after the last upload batch** — the viewport
  uses R3F `frameloop="demand"`, so a missing `invalidate()` after the final
  `setTimeout`-based batch means the new cuboid geometry is never painted.

Tests:

- `FdmCuboidLayer.test.ts` source/behavior tests for matrix upload dependency
  on `shaderVisible` and `wireframeVisible`;
- R3F smoke if available.

## FDM Airbox / Bounds Visualization

FDM does not have a separate airbox mesh. `AirboxLayer` is FEM-only (it
requires tetra topology mesh parts with `role: "air"`). For FDM sessions,
`topologyModel.airboxParts` is empty, so `AirboxLayer` renders nothing. This
is correct behavior.

The FDM domain boundary is visualized by `DomainBoxLayer` — a simple wireframe
`BoxGeometry` drawn around the domain bounds. Its visibility is controlled by
`fdmSettings.boundsVisible`, which defaults to `false` (from
`DEFAULT_OBJECT_VISUALIZATION`). This is also correct: the FDM cuboid grid
itself shows the domain extent, and a separate bounds box is optional.

No changes to airbox or bounds visualization are needed unless the user
explicitly requests showing the FDM domain wireframe box by default.

## FDM Features Not In Scope

The following viewport features are FEM-only and are correctly disabled for FDM:

- **Cross-section / clip plane** — requires FEM tetra topology.
- **Mesh size highlight** — FEM mesh quality overlay.
- **Airbox surface/wireframe with tetra geometry** — FEM-only.

These do not need repair.

## Required Verification Before Closing

Run targeted tests:

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/viewport-3d/viewport3dDomainAdapter.test.ts \
  src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts \
  src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts \
  --test-timeout=20000
```

Run broader viewport tests:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d --test-timeout=20000
```

Run real browser proof:

```bash
just run-permalloy-box-relax-fdm-ui 3100
CONTROL_ROOM_URL=http://localhost:3100/workspace \
  CONTROL_ROOM_SCREENSHOT_SCENES=fdm \
  pnpm --dir apps/control-room screenshot:viewport-3d
```

Pass criteria:

- canvas is nonblank,
- FDM cuboid surface is visible when surface is enabled,
- FDM cuboid wireframe is visible when wireframe is enabled,
- browser console has no WebGL context loss or render exceptions,
- FEM viewport smoke still passes or is explicitly checked if the repair
  touched shared viewport logic.
