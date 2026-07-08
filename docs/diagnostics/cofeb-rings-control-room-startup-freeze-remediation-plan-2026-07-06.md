# CoFeB Rings control-room startup freeze remediation plan

Date: 2026-07-06

Scope: browser freeze after mesh is ready and step-zero data starts flowing to
the control room. This report extends
`docs/diagnostics/cofeb-rings-control-room-startup-freeze-audit-2026-07-06.md`
with code-level remediation guidance.

Primary evidence:

- diagnostic suspect log: `browser.long-animation-frame` 248 ms,
  `browser.longtask` 247 ms, `fullmag.viewport3d.frame-window` up to 42012 ms,
  `field-color` queue/worker around 36500 ms, `vector-glyph` worker up to
  12349 ms, `topology-index` worker up to 7334 ms;
- slow resource fetches: `GET /v2/sessions/current/data/fields/H_eff/samples/vector`
  36523 ms and frequency-domain response endpoints during boot;
- source audit of viewport demand planning, resource hooks, vector glyph build
  and upload, field color transforms, topology index building, and telemetry
  hooks.

## Short answer

This is not one isolated slow function. The browser freezes because the first
post-mesh viewport frame is treated as a complete, high-fidelity scene build.
At the same time, the app can request heavy `H_eff` vector data, field-color
buffers, vector glyph buffers, topology indices, and frequency-domain telemetry.
Some work is offloaded to workers, but large input arrays are still copied on
the main thread and final Three.js uploads still run on the main thread.

The professional fix is to introduce a first-frame contract and a global
viewport work scheduler without lowering the visual quality of the active
visualization:

1. preserve the currently enabled visual contract: active layers, glyph density,
   field colors, topology detail, and airbox display must remain visually
   equivalent to today's output;
2. keep the browser responsive while the same-quality scene is prepared;
3. load, copy, transform, and upload only the data required for the active
   full-quality view;
4. remove accidental boot work that is not part of the active visualization;
5. enforce one scene-wide budget for duplicate work, uploads, worker jobs, and
   heavy resource requests;
6. use lower-quality display only as an explicit fallback after the
   quality-preserving path has been measured and shown to be insufficient.

This is how mature 3D applications stay interactive: the final visual state is
not degraded, while data flow, scheduling, transfer ownership, caching, and GPU
upload are engineered so the UI does not stall.

## Non-negotiable visualization rule

Optimization must preserve the visualization quality that is currently enabled
by the user or default workspace state. The default fix must not hide vectors,
silently reduce glyph density, replace field coloring with a solid fallback,
drop topology detail, or skip airbox overlays when those elements are part of
the active visual state.

Temporary lower-detail placeholders are allowed only as loading states, not as
the completed visualization. A real quality compromise must be explicitly
labelled as fallback mode, backed by measurement, and introduced only after
quality-preserving optimizations fail.

## Source-backed bottleneck matrix

Each item below names the exact code that currently creates the UI performance
risk. The proposed fixes are quality-preserving by default: they remove
unneeded work, duplicate work, unprioritized work, full-buffer copies, and
frontend derivations. They do not hide active layers or reduce visual density as
the default strategy.

### 1. Airbox or secondary quantity vectors can enter boot accidentally

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:2636-2651`

```ts
const airboxFieldVectorEnabled = Boolean(
  (airboxVectorsVisible && !airboxSettings.airboxSyntheticVectorsEnabled) ||
    airboxSurfaceColorMode,
);
```

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:2766-2771`

```ts
const airboxFieldVectors = useViewport3DAirboxFieldVectors(
  airboxSettings.activeQuantityId,
  airboxFieldVectorParts,
  airboxFieldVectorEnabled && airboxFieldVectorParts.length > 0,
  airboxFieldVectorRequests,
  { pauseLoad: fieldUpdateHoldActive },
);
```

Why this hurts: `airboxSurfaceColorMode` alone can enable airbox field-vector
loading. If the active airbox quantity is `H_eff`, the hook can issue the slow
`/data/fields/H_eff/samples/vector` request during boot. The suspect log shows
that request taking 36523 ms.

Fix:

- Split `airboxSurfaceColorNeeded` from `airboxVectorGlyphNeeded` in
  `useViewport3DSceneModel.ts`.
- Surface coloring may request only the exact scalar/component/surface data
  needed to reproduce the current color output.
- Vector glyph data is requested only when vectors are visible and the request
  belongs to the active visual state.
- If active `H_eff` vectors are visible, keep the same glyph quality but route
  them through the prioritized visible-work queue described below.
- Add diagnostics that explicitly label `H_eff` as `active-visible`,
  `hidden-layer`, or `background-analysis`.

Proof required:

- `useViewport3DSceneModel.test.ts`: default boot with airbox surface coloring
  does not enqueue `H_eff/samples/vector` unless `H_eff` vectors are visible.
- A second test where `H_eff` vectors are explicitly visible proves the request
  still exists and the configured glyph density is preserved.

### 2. Surface color plus vectors can widen a sampled glyph request to full data

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts:312-321`

```ts
if (plan.vectors.visible) {
  demands.push({
    component: "full",
    completeness: plan.shader.visible && plan.shader.scalarColorMode
      ? "complete"
      : "sampled-ok",
    maxSamples:
      plan.shader.visible && plan.shader.scalarColorMode
        ? null
        : Math.max(0, Math.floor(options.maxSamples ?? plan.vectors.budget)),
```

- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts:939-940`

```ts
if (!vectorsVisible || surfaceColorMode) {
  return query;
}
```

- Existing test that locks in the problematic widening:
  `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts:488-518`
  currently expects `"vector-glyph:full:complete"` and one merged full request.

Why this hurts: when shader surface coloring is active, the glyph pass is marked
`complete` and loses `maxSamples`. A user-visible glyph budget can therefore
fail to cap the actual field-vector payload.

Fix:

- Keep surface and glyph demands separate through
  `planViewport3DFieldResourceRequests(...)`.
- Surface pass:
  - requests the exact component/scalar/surface projection needed for the same
    color result;
  - may be complete when the active surface visual state requires it.
- Vector-glyph pass:
  - keeps `component: "full"`;
  - keeps sampled completeness and `max_samples` equal to the configured visual
    density;
  - must not be widened merely because the same target also has a shader pass.
- Update `mergeFieldDemands(...)` or its caller so merging a surface demand with
  a glyph demand cannot erase the glyph sampling contract.

Proof required:

- Replace the test expectation at
  `viewport3DFieldDataPlan.test.ts:488-518` with two requests or a merged
  request that still preserves sampled glyph semantics.
- Add a regression test for `surfaceColorSource="component_x"` plus
  `vectorsVisible=true` asserting the glyph request retains `max_samples`.

### 3. Field-vector collections start multiple heavy requests in parallel

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:788-823`
  uses `Promise.all(...)` for airbox field-vector requests.
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:920-950`
  uses `Promise.all(...)` for quantity field-vector requests.
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:1004-1034`
  uses `Promise.all(...)` for part field-vector requests.
- The cache is finite:
  `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:47-48`
  sets `fieldVectorCache` to 128 MiB.

Existing positive behavior:

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts:792-808`
  proves identical cache keys are deduplicated.

Why this still hurts: dedupe helps only when cache keys are identical. Boot can
produce different heavy keys for primary, part, airbox, and target quantities.
`Promise.all(...)` starts them together, so `H_eff`, field color, glyph, and
topology work compete with the same first-frame path and can churn the 128 MiB
field-vector cache.

Fix:

- Replace collection-level `Promise.all(...)` with a viewport field request
  queue.
- Queue ordering:
  1. active visible primary surface/color data;
  2. active selected object or visible mesh-part vectors;
  3. active visible airbox vectors;
  4. hidden layer and secondary target resources;
  5. analysis/background resources.
- Keep quality by preserving every active request; change only the order,
  concurrency, and cancellation.
- Limit heavy field-vector concurrency to 1-2 requests until the active visual
  state is ready.
- Emit diagnostics with resource key, quantity, scope, priority, byte count,
  cache hit/miss, and cancellation reason.

Proof required:

- `viewport3dResources.test.ts`: different field-vector keys are not launched
  all at once; primary visible request starts before airbox/secondary requests.
- Cache test: equivalent request identity does not duplicate network work, and
  unrelated secondary requests do not evict the primary visible vector before
  the same-quality scene is committed.

### 4. Glyph budget is applied locally, while demand is built in several paths

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DFieldRenderOptions.ts:181-217`
  applies `limitViewport3DFieldRenderVectorBudgets(...)` inside render options.
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DFieldRenderOptions.ts:262-335`
  distributes a `maxVectorGlyphs` budget across part budgets.
- Separate demand sources are then built in
  `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:2675-2772`
  for airbox, magnetic parts, and target quantities, and in
  `useViewport3DSceneModel.ts:2991-3192` for the primary field.
- The render model separately builds part and full vector segments in
  `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts:920-1026`.

Why this hurts: the existing budget is useful but not a single scene-wide work
ledger. Different demand paths can still create duplicate or widened work. The
fix must preserve configured density exactly once, not silently reduce it.

Fix:

- Add a `Viewport3DVisualWorkBudget` or equivalent at the scene-model boundary.
- The budget records active visual consumers before any resource request:
  primary, part, airbox, target quantity, analysis overlay.
- Spend the configured glyph density once across the active visible consumers.
- Use the ledger to build request keys, diagnostics, and upload work.
- Treat budget reduction as explicit fallback/degraded mode only.

Proof required:

- `useViewport3DFieldRenderOptions.test.ts` and
  `useViewport3DSceneModel.test.ts`: total active glyph demand equals the
  configured density once across all active consumers.
- Test that adding an airbox target cannot create a second uncapped vector
  request for the same visual density.

### 5. Worker offload still copies full buffers on the main thread

Code causing the risk:

- Vector glyph scheduler:
  `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts:216`

```ts
const segments = new Float32Array(input.segments);
```

- Field-color scheduler:
  `apps/control-room/src/modules/viewport-3d/viewport3dColorTransformScheduler.ts:288`

```ts
const values = new Float64Array(fieldVector.values);
```

- Topology-index scheduler:
  `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexScheduler.ts:222-240`

```ts
const boundaryFaces = new Uint32Array(input.topology.boundaryFaces);
const indices = new Uint32Array(input.topology.indices);
```

Why this hurts: workers reduce compute blocking, but these lines still clone
large buffers on the main thread before `postMessage`. This can produce
`browser.longtask` and `browser.long-animation-frame` records even when worker
time dominates the final diagnostic.

Fix:

- Introduce read-only decoded-buffer ownership for viewport worker jobs:
  transferable snapshots, reference-counted transferable copies, or
  `SharedArrayBuffer` where available.
- Avoid cloning full arrays when the task needs only a component, surface, or
  sampled scope.
- Move sample selection before worker transfer so glyph/color workers receive
  the smallest buffer that still reproduces the active visual quality.
- Preserve airbox sampled ordering: do not resample an already sampled backend
  payload after magnetic-node exclusion.

Proof required:

- Scheduler tests assert that worker jobs use transferable/snapshot ownership
  and do not allocate full-size typed-array clones for unchanged active buffers.
- Browser diagnostic records separate main-thread copy time from worker compute
  time and fail if copy time crosses the first-frame budget.

### 6. Vector glyph upload performs per-glyph matrix work on the main thread

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx:801-842`
  loops over every glyph and runs `quaternion.setFromUnitVectors(...)`,
  `matrix.compose(...)`, and two `setMatrixAt(...)` calls.
- `VectorFieldLayer.tsx:855-873` commits full matrix update ranges in
  `onVisible`.
- `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts:233-237`
  calls `ticket.onVisible()` after chunking, but `onVisible()` itself is not
  budgeted.
- `VectorFieldLayer.tsx:660-668` creates a local upload manager for each layer.

Why this hurts: chunking limits some upload work, but the expensive per-glyph
matrix composition and final visibility commit still run on the main thread.
Multiple layer-local upload managers also make it hard to protect one global
frame budget.

Fix:

- Preserve current glyph appearance and density, but change representation:
  - preferred: shader-oriented instancing from position/vector/scale attributes
    with the same shaft/head shape, colors, scale, and orientation;
  - transitional: compute matrix arrays in the worker and upload raw
    `Float32Array` matrices without per-glyph `Matrix4.compose(...)` on the
    main thread.
- Move `onVisible()` into the budgeted upload scheduler or split it into
  budgeted visibility-commit chunks.
- Replace layer-local upload managers with a shared viewport upload owner that
  knows first-frame/active-visible/background priority.

Proof required:

- `VectorFieldLayer.test.ts`: active glyph count and visual parameters are
  unchanged for the same input.
- `viewport3dGpuUploadManager.test.ts`: `onVisible` work is measured/budgeted.
- Browser smoke: no repeated long animation frames during glyph upload at the
  current configured density.

### 7. Field-color builds can scan and transform full vectors repeatedly

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts:65-94`
  dispatches full-domain, mapped, sampled, surface-face, and thickness-average
  color builds from the full field vector.
- `viewport3dFieldColorBuildModel.ts:97-118` estimates input bytes as the full
  vector plus target buffers for several target kinds.
- `viewport3dFieldColorBuildModel.ts:285-296` scans `fieldVector.pointCount`
  when a scalar range is not provided.
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.ts:857-872`
  and `918-930` schedule field-color builds for full/part modes.

Why this hurts: the suspect report shows a `field-color` worker around 36500 ms.
The code path can copy the full field vector, scan it for min/max, then build
output buffers. Repeating this per mode/target wastes memory bandwidth.

Fix:

- Keep field-color output identical, but change data ownership and reuse:
  - use field metadata/range resources before scanning full vectors;
  - cache scalar ranges by quantity, component, topology, and field revision;
  - request scalar/surface projection resources when they can reproduce the
    same color semantics;
  - combine compatible color-mode builds per field revision instead of scanning
    the same vector repeatedly;
  - transfer only scoped/component buffers to workers where possible.

Proof required:

- `viewport3dFieldColorBuildModel.test.ts`: same color values as the current
  baseline for component, magnitude, orientation, surface-face, and
  thickness-average modes.
- Performance diagnostic test: repeated same-revision color builds reuse range
  and decoded buffers instead of rescanning/copying the full field.

### 8. Topology-index work derives expensive exact topology in the frontend

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexModel.ts:52-60`
  builds fallback surface faces, surface edges, surface nodes, full volume edges,
  and airbox volume-edge fallback.
- `viewport3dTopologyIndexModel.ts:135-195` loops over every tetra to build
  surface/volume edge arrays.
- `viewport3dTopologyIndexModel.ts:299-340` scans all tetrahedra again to build
  unclaimed airbox volume edges.
- `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexScheduler.ts:222-240`
  clones `boundaryFaces` and `indices` before transferring to the worker.

Why this hurts: a 5-7 s `topology-index` worker time is expected when full
tetra topology is processed this way. The quality requirement means we should
not drop topology detail; we should stop deriving exact detail on the frontend
critical path.

Fix:

- Add or consume v2 binary resources for exact scoped topology products:
  surface faces, surface edges, volume edges, airbox hidden/bounds edges, and
  per-part node selections.
- Preserve exact current visual detail by moving precomputation to backend or
  mesh artifact generation.
- Keep frontend derivation only as diagnostic fallback with explicit degraded
  status.
- Keep topology rebuilds separate from field-buffer swaps, matching
  `docs/specs/frontend-v2/05-viewport-architecture.md`.

Proof required:

- `useViewport3DTopologyIndexBundle.test.ts`: boot uses scoped/precomputed
  topology resources when present.
- Browser diagnostics: `topology-index` frontend worker is not required for the
  active high-quality first scene when backend topology resources exist.

### 9. Frequency-domain resources are fetched before the UI knows they are needed

Code causing the risk:

- `apps/control-room/src/modules/footer/FooterTelemetry.tsx:74-79`

```ts
const responseProgress = useFrequencyDomainResponseProgressResource({
  enabled: Boolean(status),
});
const responseSweep = useFrequencyDomainResponseSweepResource({
  enabled: Boolean(status),
});
```

- `FooterTelemetry.tsx:583-620` decides whether progress is visible only after
  the resources have already been requested.
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts:454-459`
  enables frequency-domain resources from generic artifact/stage revisions.
- `apps/control-room/src/modules/explorer/ExplorerModule.tsx:247-265` enables
  several frequency-domain resources from broad tab state.

Why this hurts: the suspect log includes slow
`analysis/frequency-domain/response/*` requests during boot. These are not part
of the active 3D visualization and should not compete with viewport resources.

Fix:

- Add a cheap prefetch gate from status/stage execution/manifest availability:
  active stage kind is frequency response/eigenmodes, or a frequency-domain
  result node is active, or manifest says the specific response artifact exists.
- Move this gate before `useFrequencyDomainResponseProgressResource(...)` and
  `useFrequencyDomainResponseSweepResource(...)`.
- Tighten `shouldLoadFrequencyDomainManifest(...)`; generic
  `artifact_revision`, `artifacts_revision`, or `stages_revision` is too broad
  for response endpoints.
- Keep optional resources like cancel-requested behind manifest availability,
  as already done in `ExplorerModule.tsx:266-274`.

Proof required:

- `FooterTelemetry.test.ts` and `studyRuntimeResources.test.ts`: plain mesh or
  viewport boot does not fetch response progress/sweep.
- Frequency-domain active-stage test: response progress/sweep still load when
  the active stage/result actually needs them.

### 10. Some viewport resources have no explicit active-view gate

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:2141-2146`

```ts
const scene = useViewport3DScene();
const universe = useViewport3DUniverse();
const sharedDomainManifest = useViewport3DSharedDomainManifest();
```

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:1092-1104`
  and `1107-1117` expose `useViewport3DSharedDomainManifest()` and
  `useViewport3DScene()` without an `enabled` parameter.
- `apps/control-room/src/kernel/resources/useResource.ts:51-59` defaults
  `enabled = true`.

Why this hurts: any mounted scene-model path can load these resources. This is
reasonable only if the 3D viewport is the active mounted center surface. It
violates the frontend-v2 lifecycle rule that inactive heavy modules must not
keep 3D-only resource listeners alive.

Fix:

- Add `enabled` options to `useViewport3DScene()`,
  `useViewport3DSharedDomainManifest()`, and other viewport-only resource hooks.
- Thread the active `viewport-main` module state into `useViewport3DSceneModel`.
- Keep lightweight command manifests available, but do not fetch 3D-only scene,
  topology, manifest, field, or quality resources while the 3D viewport is not
  mounted.

Proof required:

- Center-tab lifecycle test: switching away from `viewport-3d` unmounts the 3D
  module and leaves no active 3D field/topology/manifest resource hooks.
- Idle audit: status ticks and non-3D tabs do not dirty or refetch 3D resources.

### 11. Build and upload schedulers are local, not one prioritized work graph

Code causing the risk:

- `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.ts:57-67`
  defines lane concurrency, but each subsystem creates its own scheduler.
- Vector glyph scheduler:
  `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts:155-158`.
- Field-color scheduler:
  `apps/control-room/src/modules/viewport-3d/viewport3dColorTransformScheduler.ts:129-132`.
- Topology-index scheduler:
  `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexScheduler.ts:153-156`.
- `viewport3dBuildScheduler.ts:96-101` and `142-147` abort obsolete jobs only
  within the same lane/group.
- GPU upload is coordinated separately in
  `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts:275-374`.

Why this hurts: there is no single owner that can say "this active field color
is more important than that hidden airbox glyph" across network, worker, and GPU
upload. Local schedulers can each be correct and still overload the same boot
window.

Fix:

- Introduce `Viewport3DWorkGraph` or an equivalent coordinator.
- Every resource fetch, decode, worker build, GPU upload, and visibility commit
  declares:
  - priority: active-visible, interaction, hidden-layer, analysis/background;
  - lane: network, binary-decode, topology-index, field-color, vector-glyph,
    gpu-upload;
  - byte/item cost;
  - dependency and cancellation group;
  - visual consequence.
- Keep current visual quality; the graph changes ordering, cancellation, and
  resource ownership, not the final enabled visual state.

Proof required:

- `viewport3dBuildScheduler.test.ts` plus a new work-graph test: hidden-layer
  jobs cannot start ahead of active-visible jobs when both are pending.
- Browser diagnostic: one critical-path timeline spans request, worker build,
  main adopt, GPU upload, and visible commit.

## Root cause model

The freeze comes from four coupled overloads:

1. **Data-plane overload**: the boot path may request full or large sampled
   vectors for `H_eff`, airbox, and secondary targets before the user needs
   them.
2. **Worker-plane overload**: vector glyphs, field colors, and topology indices
   run in separate schedulers. They are cancellable in places, but there is no
   single first-frame priority model.
3. **Main-thread/GPU overload**: typed-array copies, worker result adoption,
   Three.js attribute creation, instanced matrix composition, and final material
   commits remain on the main thread.
4. **Product-behavior overload**: full-quality visualization work is executed
   as one blocking critical path instead of as a responsive, prioritized
   pipeline.

The existing code already has useful pieces: demand rendering, worker
schedulers, upload chunking, dirty-frame rendering, and vector budgets. The
problem is that these mechanisms are local. The viewport needs one global
policy deciding what is allowed to happen before the first stable frame.

## P0 fixes: stop the boot freeze without quality loss

These changes should be implemented first because they directly target the
suspect log.

1. **Add a quality-preserving first-frame work policy**
   - New concept: `Viewport3DFirstFramePolicy` or equivalent in the viewport
     scene-model layer.
   - The policy separates "browser is responsive" from "completed
     visualization is ready". It must not commit a downgraded visualization as
     the completed state.
   - Active visible layers remain first-class work: if vectors, airbox,
     field-color, or topology detail are enabled, the scheduler prepares the
     same-quality output with higher priority and better resource ownership.
   - Exclude only work that is not required by the active visual state:
     hidden layers, stale secondary targets, duplicate requests, and unrelated
     analysis resources.
   - During loading, keep the previous valid view or an explicit loading state.
     Do not replace the active visualization with silent low-quality output.

2. **Gate frequency-domain telemetry before it fetches**
   - Change `FooterTelemetry.tsx` so response progress/sweep hooks are enabled
     only when an active stage or known artifact indicates frequency-domain
     response work.
   - Tighten `shouldLoadFrequencyDomainManifest(...)` in
     `studyRuntimeResources.ts` so generic artifact/stage revision does not
     imply response resources.
   - Reuse the stricter pattern already used for cancel-requested resources:
     load optional response artifacts only after availability is known.

3. **Split surface color demand from vector glyph demand**
   - In `viewport3DFieldDataPlan.ts`, do not let surface coloring upgrade a
     glyph request to full-vector completeness.
   - Surface color should request the exact scalar or derived component data
     needed to reproduce the current field-color output.
   - Glyphs should preserve the configured visual density, with `max_samples`
     representing the requested quality once globally, not as a hidden
     downgrade.
   - Airbox rendering should keep the active visual contract. A solid fallback
     is acceptable only as an explicit loading/fallback state.

4. **Make vector budget hard and global**
   - Use one scene-level vector budget across primary field, parts, airbox,
     target quantities, and FDM/FEM overlays.
   - The budget must preserve the configured visual density exactly once across
     the whole scene.
   - Adaptive reduction is not a default optimization. It belongs behind an
     explicit fallback/degraded-mode decision after measurement.

5. **Prioritize heavy resource hooks**
   - Replace `Promise.all(...)` collection fetches for field vectors with a
     small prioritized queue.
   - Priority order:
     1. primary quantity needed for visible surface;
     2. currently selected object or mesh part;
     3. sampled vector glyphs for visible targets;
     4. airbox vectors;
     5. non-visible or analysis/background resources.

## P1 architecture: make it professional

P0 prevents the immediate stall. P1 turns the viewport into a serious 3D
runtime.

### Unified viewport work graph

Create a single scheduler for the viewport critical path:

```text
resource request -> decode/adopt -> worker build -> GPU upload -> visibility commit
```

Each task should declare:

- priority: first-frame, visible-interaction, refinement, background;
- lane: network, binary-decode, topology-index, field-color, vector-glyph,
  gpu-upload;
- cost estimate: bytes, glyph count, topology count, upload bytes;
- dependencies;
- cancellation group;
- visibility consequence.

The scheduler should guarantee:

- only first-frame tasks can block first visible canvas;
- background tasks are cancelled or paused during camera interaction;
- a newer quantity/style request cancels obsolete work before worker/GPU spend;
- GPU upload and `onVisible()` commits are budgeted, not just worker chunks.

### Quality-preserving staged execution

Use explicit execution stages instead of one blocking scene build. These stages
are scheduling states, not permission to lower the completed visual quality.

| Stage | Goal | Allowed work |
|---|---|---|
| S0 | keep browser responsive while resources arrive | prior valid view or explicit loading state |
| S1 | build exact active topology resources | scoped/precomputed topology matching current detail |
| S2 | build exact active field colors and glyphs | configured field-color output and glyph density |
| S3 | load hidden/secondary/analysis resources | non-visible or non-active resources only |
| S4 | fallback mode | reduced detail only after measured failure and explicit opt-in |

This model should be visible in diagnostics so a slow hidden/analysis task
cannot be mistaken for a failed active visualization. The completed S1/S2 scene
must be visually equivalent to today's active view.

### Backend-provided scoped resources

The frontend should not derive every expensive topology artifact from full
tetra data on boot. Add or use v2 resources for:

- surface edge indices per mesh part;
- exact scoped topology resources for the active detail level;
- airbox bounds and hidden-edge overlays;
- sampled field vectors with stable sampling seed;
- scalar/surface projections and server-side min/max ranges where available.

For P0, this can be frontend-only gating. For P1/P2, OpenAPI and generated
frontend types should expose the new scoped resources.

### GPU-oriented glyph rendering

The current glyph renderer builds CPU transforms and uploads per-instance
matrices for shaft and head meshes. For large vector fields, move toward
visually equivalent GPU-oriented rendering:

- shader-oriented instancing from position/vector/magnitude attributes while
  preserving the current glyph shape, scale, color, and density;
- GPU color mapping from scalar/vector attributes where possible;
- CPU `Matrix4.compose(...)` only when it is required to match the visual
  contract.

This reduces main-thread work and makes glyph count a GPU budget, not a CPU
matrix-composition budget.

### Binary buffer ownership

Worker offload should avoid main-thread copies of huge typed arrays. The target
architecture should be:

- binary decode produces transferable or shared immutable buffers;
- worker tasks receive views or ownership without cloning full arrays;
- sampled/scoped transforms copy only the selected component/range;
- cache entries track memory class and eviction cost.

Raising cache limits alone is not a fix, but cache telemetry should expose when
`fieldVectorCache` churn causes repeated downloads or rebuilds.

## P2 observability and quality gates

Add diagnostics that report the full critical path:

- request start/end and byte count;
- worker queued/started/completed/adopted;
- main-thread copy/adopt time;
- GPU upload queued/completed;
- visible-frame commit time;
- cancellation reason;
- task priority and first-frame eligibility.

Required performance gates:

- no default boot request to
  `/v2/sessions/current/data/fields/H_eff/samples/vector` when `H_eff` is not
  part of the active visualization;
- no default boot request to
  `/v2/sessions/current/analysis/frequency-domain/response/*` unless a
  frequency-domain stage/artifact is active;
- no first-frame `fullmag.viewport3d.frame-window` above 1000 ms for the CoFeB
  rings profile;
- no repeated main-thread long task above 100 ms during first-frame readiness;
- zero idle 3D frames after the viewport settles;
- visual parity against the current high-quality baseline: same active layers,
  glyph density, field-color semantics, topology detail, and airbox overlays;
- canvas visible, WebGL context alive, and drawing buffer non-zero in browser
  smoke tests.

## Implementation sequence

### Phase A: remove non-essential boot work

Files:

- `apps/control-room/src/modules/footer/FooterTelemetry.tsx`
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`

Tests:

- frequency-domain hooks do not fetch response progress/sweep on plain boot;
- accidental/non-visible airbox/`H_eff` vectors are not loaded on boot;
- active airbox/`H_eff` visualization remains full quality and is prioritized;
- surface color does not force full-vector glyph demand;
- scene model emits diagnostics for deferred work.

### Phase B: enforce global budgets and priorities

Files:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DFieldRenderOptions.ts`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`

Tests:

- total glyph demand never exceeds scene budget;
- collection vector requests are ordered and cancellable;
- primary visible resource is loaded before airbox/secondary vector resources.

### Phase C: unify worker and upload scheduling

Files:

- `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.ts`
- `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts`
- `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts`

Tests:

- obsolete glyph/color/topology jobs are cancelled before heavy work starts;
- camera interaction pauses hidden/background work without changing active
  visual quality;
- upload commits stay within frame budget and do not create long animation
  frames.

### Phase D: backend-scoped topology and field resources

Files depend on the chosen API shape, but the change should flow through:

- OpenAPI v2 session resources;
- generated frontend transport/types;
- typed session API facade;
- resource hooks;
- viewport render-model consumers.

Tests:

- scoped topology resources replace frontend full-topology derivation on boot;
- sampled field-vector endpoint honors `max_samples`, scope, quantity, and
  stable sampling seed;
- old full-resource paths remain available only for explicit high-detail
  actions.

## Verification commands

Run focused tests during implementation:

```bash
pnpm --dir apps/control-room test -- --run FooterTelemetry.test.ts studyRuntimeResources.test.ts
pnpm --dir apps/control-room test -- --run viewport3DFieldDataPlan.test.ts useViewport3DSceneModel.test.ts viewport3dResources.test.ts
pnpm --dir apps/control-room test -- --run VectorFieldLayer.test.ts useViewport3DScalarColorUpload.test.ts viewport3dBuildScheduler.test.ts viewport3dGpuUploadManager.test.ts
```

Run final gates for any production code change:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:compute-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

For viewport changes, also run a real browser smoke against the CoFeB rings
boot profile or the closest available fixture. The smoke must assert:

- canvas is visible;
- WebGL context is not lost;
- drawing buffer is non-zero;
- default boot does not request `H_eff/samples/vector` when `H_eff` is not part
  of the active visual state;
- active `H_eff` visualization preserves current quality and avoids duplicate
  or widened requests;
- default boot does not request frequency-domain response resources;
- full-quality active visualization is reached while unrelated background work
  remains deferred.

## What not to do

- Do not only increase request timeouts. The issue is excessive critical-path
  work, not just a slow server.
- Do not permanently hide vectors as the only fix. Vectors are useful; they
  need progressive loading and hard budgets.
- Do not silently lower visual quality, glyph density, field-color fidelity,
  topology detail, or airbox overlays. Quality reduction is fallback mode, not
  the default optimization strategy.
- Do not only move more code to workers. Worker output still has to be copied,
  adopted, uploaded, and committed on the main thread.
- Do not only raise cache sizes. Cache churn may contribute, but the first-frame
  demand graph is the main problem.
- Do not throttle React renders and call it done. The heavy work is mostly data,
  worker, Three.js, and GPU-upload scheduling.

## Acceptance criteria

The fix is complete when the CoFeB rings boot scenario satisfies all of these:

1. Mesh-ready step-zero boot shows a stable first viewport frame before optional
   hidden-layer or analysis work, while preserving the active visual contract.
2. No default boot request is made to
   `/v2/sessions/current/data/fields/H_eff/samples/vector` when `H_eff` is not
   part of the active visualization.
3. No default boot request is made to
   `/v2/sessions/current/analysis/frequency-domain/response/*` unless a
   frequency-domain stage or artifact is actually active.
4. Scene-wide glyph count is bounded by one global budget that preserves the
   configured density without duplicate demand.
5. Exact active topology detail is available through scoped/precomputed data,
   not by deriving every topology artifact on the frontend critical path.
6. Worker and GPU upload diagnostics show clear priorities, cancellations, and
   per-lane timings.
7. Browser smoke proves canvas visibility, live WebGL context, non-zero drawing
   buffer, bounded first-frame time, and visual parity with the current
   high-quality baseline.
8. Any quality reduction is implemented only as explicit fallback/degraded mode
   with diagnostics and separate acceptance criteria.
9. `pnpm --dir apps/control-room typecheck`, `lint`, and `test` pass after the
   code changes.

## Resource-first API impact

P0 can be done without changing OpenAPI if it only gates existing hooks and
changes frontend demand planning.

P1/P2 likely require v2 resource additions for scoped topology, sampled fields,
server-side scalar projections, and availability metadata. Those changes must
go through the canonical resource-first path:

1. OpenAPI contract;
2. generated frontend transport/types;
3. typed API facade;
4. resource hooks;
5. viewport render-model consumers;
6. realtime revision invalidation.

React components should continue to consume resource hooks and render models;
they should not hand-roll endpoint strings or direct `fetch()` calls.
