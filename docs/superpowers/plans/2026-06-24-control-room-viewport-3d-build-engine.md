# Control Room Viewport 3D Build Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade 3D visualization build engine for `apps/control-room` so full-quality FEM/FDM 3D visualization can load, rebuild, and update without freezing the browser main thread.

**Architecture:** Move expensive visualization derivation out of React render and out of the browser main thread into a bounded visualization job graph with worker-pool lanes, revision-keyed caches, stale-while-rebuild presentation, and frame-budgeted GPU uploads. Keep one R3F demand-driven canvas, preserve the full visual contract, and make every expensive phase measurable in diagnostic artifacts.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Playwright/Chromium diagnostics, Three.js/R3F, Web Workers, Transferable typed arrays, Fullmag v2 resource-first API facade, existing viewport diagnostics and diagnostic recorder.

---

## Executive Decision

The browser freeze must be fixed by changing ownership and scheduling of visualization work, not by reducing visualization quality.

The correct production direction is a dedicated `Viewport3DVisualizationBuildEngine` between resource hooks and R3F layers:

```text
v2 resource hooks
  -> domain adapters and render-model inputs
  -> visualization job graph
  -> worker-pool build lanes
  -> revision-keyed derived-buffer cache
  -> frame-budgeted GPU upload manager
  -> stable R3F resource owners
  -> demand-rendered canvas
```

The main thread may orchestrate, receive worker results, create/update WebGL resources, handle pointer/camera events, and submit draw calls. It must not synchronously build topology indices, vector glyph transforms, scalar color arrays, overlay index maps, mesh-quality maps, text geometry, or large derived render buffers during startup or field updates.

This is the same product pattern used by serious simulation tools: the UI is an interactive control room over a result/postprocessing pipeline, not the place where every derived visualization buffer is synchronously computed. Public COMSOL documentation describes separate application areas for model building, computation, results/visualization, server execution, and programmatic control. We should learn from that separation without claiming knowledge of COMSOL internals.

Reference links reviewed earlier:

- `https://www.comsol.com/comsol-multiphysics`
- `https://www.comsol.com/comsol-server`
- `https://www.comsol.com/livelink-for-matlab`
- `https://www.comsol.com/release/6.4`

## Current Evidence

The latest controlled cold FEM diagnostic used:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Important artifact:

```text
.fullmag/reports/cofeb-rings-relax-diagnostics/browser/2026-06-24T10-23-22-498Z-viewport-3d
```

Observed case:

- mesh: `59620` nodes, `342415` tetrahedra, `92144` boundary faces;
- screenshot confirmed full visualization with mesh-ready state, airbox, region overlays, and orientation HUD;
- max main-thread long task: `14374 ms`;
- max long animation frame: `1469 ms`, blocking `1418 ms`;
- max viewport frame window: `15049.6 ms`, dirty reasons included `vector-glyph-material`, `field-colors`, and `region-mesh-overlay`;
- vector glyph build wall times appeared as `9234.9 ms`, `6198 ms`, `5213.1 ms`, `4085.8 ms`, `2407.3 ms`, `1458.5 ms`, and `233.5 ms`;
- topology resource path reported about `1654 ms`, including transport and decode;
- current vector glyph work is already off-main-thread, but several independent glyph jobs queue behind one worker and still cause delayed final presentation;
- there is still at least one unattributed multi-second main-thread freeze, so the build engine must improve attribution as well as scheduling.

The interpretation is not "vectors are bad" or "3D is too detailed". The interpretation is that the current viewport mixes too many expensive visualization phases with React/R3F lifecycle and lacks a central scheduler that can bound concurrency, deduplicate work, keep the UI interactive, and expose root-cause timings.

## Non-Negotiable Acceptance Criteria

1. Full-quality visualization remains the default target.
2. Performance fixes must not silently disable mesh, field colors, vector glyphs, region overlays, airbox semantics, HUD, dimension frame, or selection overlays.
3. Main-thread tasks above `100 ms` during startup or visualization update are bugs unless explicitly proven to be unavoidable browser/GPU driver work.
4. No single visualization build phase may monopolize the main thread.
5. Camera orbit, pan, zoom, selection hover, and menu interactions stay responsive while visualization buffers are building.
6. The viewport remains one R3F `<Canvas frameloop="demand">`.
7. Idle viewport frames settle to zero after resources and uploads finish.
8. Topology revision changes and field revision changes remain separate.
9. Large typed arrays do not live in React state.
10. WebGL resources, workers, object URLs, observers, subscriptions, and derived typed arrays have explicit owners and release triggers.
11. Diagnostics record enough evidence for Codex and a human engineer to identify the next bottleneck without guessing.

## Production Strategy

### Principle 1: Render Quality Is Not A Performance Knob

Visibility flags are useful diagnostic tools, not production fixes.

Production can use progressive readiness, but the final state must be identical in quality:

- render previous full-quality buffers while a new revision builds;
- show exact revision/build state in diagnostics and, where needed, in subtle UI status;
- replace buffers atomically when the new revision is ready;
- never claim the new field/topology revision is fully displayed until all required lanes have completed.

### Principle 2: Main Thread Owns Interaction And GPU Submit Only

Allowed main-thread work:

- React state transitions for small scalar/UI state;
- R3F layer mount/unmount;
- camera controls and pointer handling;
- WebGL buffer creation and sub-data upload under a strict per-frame budget;
- command dispatch and diagnostics event recording.

Disallowed main-thread work:

- deriving vector glyph transforms for large fields;
- deriving vector glyph colors for large fields;
- building topology surface/edge/part indices;
- deriving scalar field color arrays for large meshes;
- building region overlay face maps;
- computing mesh quality arrays;
- parsing large binary payloads synchronously;
- rebuilding topology from field-only changes;
- measuring text/layout in a loop during viewport startup.

### Principle 3: Build Jobs Are Addressed By Revisions

Every expensive derived buffer must be keyed by semantic inputs:

```text
sessionId
domainId
topologyRevision
fieldRevision
quantityId
component
scopeKind
scopeId
targetVisualizationRevision
styleRevision
samplingRevision
buildAlgorithmVersion
```

If none of those keys changed, the build must be reused.

If only camera changed, no topology, field color, vector glyph, or overlay build may run.

If only field values changed, topology indices and region topology maps must be reused.

If only style changed, geometry/topology buffers must be reused and only style-dependent derived buffers may rebuild.

### Principle 4: Build Lanes Are Bounded

The build engine owns explicit lanes:

| Lane | Work | Default concurrency | Main-thread budget |
|---|---|---:|---:|
| `topology-index` | surface faces, volume edges, part lookup maps | 1 | result adoption only |
| `binary-decode` | binary data-plane decode where not already worker-backed | 1 to 2 | none |
| `field-color` | scalar color arrays and range-mapped attributes | 1 to 2 | GPU upload only |
| `vector-glyph` | glyph transforms, colors, lengths, bounds | 2 | GPU upload only |
| `region-overlay` | region face groups and overlay index maps | 1 | GPU upload only |
| `mesh-quality` | quality metrics and color buffers | 1 | GPU upload only |
| `bounds-hud` | lightweight bounds, labels, HUD geometry | 1 | tiny, interruptible |
| `gpu-upload` | BufferGeometry/InstancedMesh attribute upload | main thread only | 2 to 4 ms per frame |

Lane concurrency is deliberately small. A worker pool that saturates every CPU core can make interaction worse. The scheduler must reserve responsiveness for the main thread and browser internals.

### Principle 5: Upload Is A Separate Phase

Moving compute to workers is not enough. Creating and uploading large WebGL buffers can still freeze the UI.

Every large GPU adoption must use an upload plan:

```text
worker result
  -> derived buffer cache
  -> upload ticket
  -> per-frame upload slices
  -> final atomic layer adoption
  -> demand-render invalidation
```

No layer may perform unbounded `needsUpdate` or `setMatrixAt` loops in one frame for large data. Uploads must be chunked by bytes or instances and must yield before exceeding the frame budget.

### Principle 6: React Is Not The Buffer Store

React state may hold small status snapshots:

- job key;
- state: `idle | queued | running | uploading | ready | failed | stale`;
- revision ids;
- counts;
- error summary.

React state must not hold:

- field sample buffers;
- topology buffers;
- vector glyph matrices;
- vector glyph colors;
- scalar color arrays;
- large index arrays;
- Three.js geometry/material/texture instances.

Large mutable data belongs in resource caches, build caches, R3F refs, or explicit buffer owners exposed through `useSyncExternalStore` snapshots.

## Target Architecture

### Layer 1: Resource Inputs

Existing resource hooks stay the only frontend data path:

- `useViewport3DSceneModel`;
- typed `ControlRoomApi`;
- resource cache and binary resource helpers;
- realtime invalidation bridge;
- render-model adapters.

No R3F layer may call the API directly.

### Layer 2: Build Engine Facade

Create a module-level facade:

```text
apps/control-room/src/modules/viewport-3d/build-engine/
  viewport3dBuildEngine.ts
  viewport3dBuildEngineTypes.ts
  viewport3dBuildJobKeys.ts
  viewport3dBuildScheduler.ts
  viewport3dBuildCache.ts
  viewport3dBuildDiagnostics.ts
  viewport3dBuildEngineStore.ts
```

Responsibilities:

- normalize build requests into stable keys;
- deduplicate equivalent jobs;
- cancel obsolete jobs;
- preserve last good result where safe;
- expose compact state snapshots to React;
- record queue, worker, transfer, cache, upload, and adoption timings;
- own idle disposal of workers and derived buffers.

### Layer 3: Worker-Pool Runtime

Create worker-pool utilities local to the viewport first, then promote only if another module needs them:

```text
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/
  viewport3dWorkerPool.ts
  viewport3dWorkerPoolTypes.ts
  viewport3dWorkerPoolDiagnostics.ts
```

Pool requirements:

- bounded lane-specific concurrency;
- FIFO per lane with latest-wins cancellation for obsolete revisions;
- no global unbounded promise queue;
- no orphaned pending promises after abort/unmount;
- transfer typed-array ownership where safe;
- fall back to synchronous pure builders only in tests or unsupported browsers, and record the fallback explicitly.

Initial pool size policy:

```ts
export interface Viewport3DWorkerPoolPolicy {
  readonly topologyIndexWorkers: 1;
  readonly fieldColorWorkers: 1 | 2;
  readonly vectorGlyphWorkers: 1 | 2;
  readonly overlayWorkers: 1;
  readonly maxTotalWorkers: 4;
}
```

Use `navigator.hardwareConcurrency` only as a cap, not as a target.

### Layer 4: Derived Buffer Cache

Create revision-keyed caches:

```text
apps/control-room/src/modules/viewport-3d/build-engine/cache/
  viewport3dDerivedBufferCache.ts
  viewport3dCacheKey.ts
  viewport3dCacheEviction.ts
```

Cache rules:

- entries are immutable after ready;
- entries are reference-counted by layer adoption;
- entries expose estimated bytes;
- entries evict by revision, memory pressure, and module unmount;
- stale entries can stay visible until replacement is ready if their displayed revision is explicit.

The cache must distinguish:

- `stale-compatible`: safe to show while rebuilding, such as same topology with new style adoption pending;
- `stale-physical`: previous field revision is visible while new field revision is building; this requires an explicit status marker;
- `invalid`: must not be shown, such as topology buffers for a different mesh generation when part mapping semantics changed.

### Layer 5: GPU Upload Manager

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/gpu/
  viewport3dGpuUploadManager.ts
  viewport3dGpuUploadTypes.ts
  viewport3dGpuUploadDiagnostics.ts
```

Responsibilities:

- queue upload tickets from ready derived buffers;
- split uploads into bounded chunks;
- run only during requested animation frames;
- abort obsolete uploads;
- publish upload progress and completion;
- invalidate R3F only when visible buffers change;
- record `mainUploadMs`, `uploadBytes`, `uploadChunks`, and `uploadFrames`.

Frame budget:

- default: `3 ms`;
- hard cap: `5 ms`;
- diagnostics fail if a single upload slice exceeds `16 ms` without explicit browser/GPU attribution.

### Layer 6: R3F Layer Bridge

The R3F layers become mostly consumers:

- `VectorFieldLayer.tsx` consumes ready/uploading glyph buffer handles;
- field-color layers consume ready/uploading color buffer handles;
- mesh/region/overlay layers consume ready topology/overlay handles;
- HUD and dimension frame remain lightweight and should not block model adoption.

Layer bridge rules:

- layer render functions stay pure and small;
- expensive build requests are effects, not render calculations;
- effects publish job requests to the build engine;
- cleanup releases cache references and upload tickets;
- layer status is rendered only from small external-store snapshots.

### Layer 7: Diagnostics And Recorder

The diagnostic recorder must be able to answer:

- how long each build request waited in queue;
- which worker lane handled it;
- how long worker compute took;
- how long serialization/transfer took;
- how many bytes moved;
- how long main-thread adoption took;
- how long GPU upload took;
- whether React rerendered because of a large-data identity change;
- whether a viewport frame occurred without a dirty reason;
- whether a visible buffer is stale and why.

Required timing fields:

```ts
export interface Viewport3DBuildDiagnosticRecord {
  readonly kind: "viewport-3d-build-job";
  readonly lane: Viewport3DBuildLane;
  readonly key: string;
  readonly revisionSummary: string;
  readonly state: "queued" | "running" | "transferring" | "uploading" | "ready" | "failed" | "aborted";
  readonly queueWaitMs: number;
  readonly workerComputeMs: number;
  readonly transferMs: number;
  readonly mainAdoptMs: number;
  readonly mainUploadMs: number;
  readonly totalWallMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly itemCount: number;
  readonly droppedBecauseObsolete: boolean;
}
```

Existing `fullmag.viewport3d.*` performance measures should remain, but the build engine must add structured records so wall time is not mistaken for a main-thread block.

## File Responsibility Map

### New Build Engine Files

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineTypes.ts
```

Defines:

- `Viewport3DBuildLane`;
- `Viewport3DBuildState`;
- `Viewport3DBuildJobKey`;
- `Viewport3DBuildRequest`;
- `Viewport3DBuildResult`;
- `Viewport3DBuildDiagnosticRecord`;
- cache entry and reference types.

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.ts
```

Defines stable key builders for:

- topology indices;
- vector glyphs;
- field colors;
- region overlays;
- mesh quality;
- HUD/dimension lightweight builds.

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.ts
```

Owns:

- lane queues;
- latest-wins cancellation;
- job dedupe;
- pool dispatch;
- abort and unmount cleanup;
- sync fallback only when worker is unavailable.

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildCache.ts
```

Owns:

- ready derived buffers;
- stale-compatible and stale-physical entries;
- reference counts;
- byte accounting;
- eviction.

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineStore.ts
```

Owns:

- `useSyncExternalStore` snapshot interface;
- small immutable snapshots;
- no large typed arrays in snapshots.

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildDiagnostics.ts
```

Owns:

- conversion from scheduler events to recorder records;
- `performance.mark` and `performance.measure` names;
- dropped-event counters.

### New Worker Pool Files

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPoolTypes.ts
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPool.ts
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPoolDiagnostics.ts
```

Responsibilities:

- lane-specific worker creation;
- message correlation;
- error propagation;
- transferables;
- idle termination;
- worker count diagnostics.

### New GPU Upload Files

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadTypes.ts
apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts
apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadDiagnostics.ts
```

Responsibilities:

- upload tickets;
- chunk planning;
- per-frame budget;
- cancellation;
- WebGL buffer adoption diagnostics.

### Lane Model And Worker Files

Keep or migrate existing work into lane-specific model/worker files:

```text
apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexModel.ts
apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexWorker.ts
apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildModel.ts
apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildWorker.ts
```

Create or split as needed:

```text
apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts
apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildWorker.ts
apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildModel.ts
apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildWorker.ts
apps/control-room/src/modules/viewport-3d/mesh-quality/viewport3dMeshQualityBuildModel.ts
apps/control-room/src/modules/viewport-3d/mesh-quality/viewport3dMeshQualityBuildWorker.ts
```

Pure model files must not import React, R3F, browser config, or client scheduler code.

### Existing Files To Modify

Modify:

```text
apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts
```

Purpose:

- construct semantic build requests;
- separate topology keys from field keys;
- use engine snapshots instead of embedding derived buffers in React state.

Modify:

```text
apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx
```

Purpose:

- keep staged full-quality presentation;
- integrate engine readiness;
- keep demand rendering;
- keep model-layer stage logic from causing topology/field rebuilds.

Modify:

```text
apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx
```

Purpose:

- replace lane-local single-worker scheduling with build-engine lane requests;
- consume uploaded buffer handles;
- keep upload/adoption out of React render.

Modify:

```text
apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx
apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx
apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx
apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx
```

Purpose:

- adopt engine-owned buffers where these layers currently derive or upload large data;
- preserve visual output.

Modify:

```text
apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.ts
apps/control-room/scripts/record-diagnostics.mjs
```

Purpose:

- record build-engine lanes;
- summarize queue/worker/upload bottlenecks;
- keep diagnostic logs bounded.

## Implementation Phases

### Phase 0: Baseline And Guardrails

Goal: freeze the current measured problem surface before changing architecture.

- [ ] Add a diagnostic parser fixture from `2026-06-24T10-23-22-498Z-viewport-3d` that extracts max long task, max LOAF, top viewport frame window, and top build measures.
- [ ] Add a test or script assertion that `buildVectorGlyphInstances` wall time is classified as worker-lane wall time, not automatically as main-thread work.
- [ ] Add source tests proving no viewport layer synchronously calls large builders from render or `useMemo`.
- [ ] Add a diagnostic scenario label for `cofeb-rings-relax-full-3d-cold`.
- [ ] Run the existing full control-room gates before architecture edits:

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
```

Acceptance:

- current bottlenecks are reproducible;
- existing tests still pass;
- diagnostic output clearly separates main-thread long tasks from worker wall time.

### Phase 1: Build Engine Types, Keys, And Store

Goal: create the central contract without changing visual behavior.

- [ ] Create `viewport3dBuildEngineTypes.ts` with exact lane, state, key, request, result, and diagnostic types.
- [ ] Create `viewport3dBuildJobKeys.ts` with stable key builders.
- [ ] Add tests that a camera-only change does not alter topology, field-color, vector-glyph, or region-overlay keys.
- [ ] Add tests that a field revision change alters field-color and vector-glyph keys but not topology-index keys.
- [ ] Add tests that a topology revision change invalidates topology, overlay, field-color, and vector-glyph keys.
- [ ] Create `viewport3dBuildEngineStore.ts` with `useSyncExternalStore`-compatible snapshots.
- [ ] Add tests that snapshots are referentially stable when no small status fields changed.

Example key contract:

```ts
export interface Viewport3DBuildJobKeyParts {
  readonly lane: Viewport3DBuildLane;
  readonly sessionId: string;
  readonly domainId: string;
  readonly topologyRevision: string | null;
  readonly fieldRevision: string | null;
  readonly quantityId: string | null;
  readonly component: string | null;
  readonly scopeKind: string | null;
  readonly scopeId: string | null;
  readonly styleRevision: string;
  readonly samplingRevision: string;
  readonly algorithmVersion: number;
}
```

Acceptance:

- no visual behavior changed;
- key tests prevent camera interaction from scheduling heavy builds.

### Phase 2: Worker Pool And Scheduler

Goal: replace single ad hoc workers with a bounded shared scheduler.

- [ ] Create `viewport3dWorkerPoolTypes.ts`.
- [ ] Create `viewport3dWorkerPool.ts`.
- [ ] Create `viewport3dBuildScheduler.ts`.
- [ ] Add tests for dedupe: two identical jobs return the same pending result.
- [ ] Add tests for latest-wins cancellation: obsolete field revision jobs abort before upload.
- [ ] Add tests for bounded concurrency: vector lane runs no more than the policy limit.
- [ ] Add tests for unmount cleanup: pending promises reject with a typed abort reason.
- [ ] Add tests for worker fallback: fallback is explicit and recorded.

Core scheduler behavior:

```ts
export interface Viewport3DBuildScheduler {
  readonly schedule: <TResult>(
    request: Viewport3DBuildRequest,
    runner: Viewport3DBuildRunner<TResult>,
    options: Viewport3DBuildScheduleOptions,
  ) => Promise<TResult>;
  readonly abortObsolete: (scope: Viewport3DBuildAbortScope) => void;
  readonly dispose: () => void;
}
```

Acceptance:

- worker pool never spawns unbounded workers;
- every pending job is observable, abortable, and attributed to a lane.

### Phase 3: Vector Glyph Lane Productionization

Goal: remove the current vector-glyph queue bottleneck without reducing glyph quality.

- [ ] Move `vectorGlyphBuildScheduler.ts` behind the build engine vector lane.
- [ ] Keep `vectorGlyphBuildModel.ts` pure.
- [ ] Add vector lane job keys containing topology revision, field revision, vector scope, color mode, glyph scale, and sampling budget.
- [ ] Dedupe identical vector glyph builds across layers.
- [ ] Use a bounded vector worker pool, default maximum `2`.
- [ ] Preserve last good glyph buffers while the new compatible request is queued or running.
- [ ] Mark previous-field glyphs as `stale-physical` if a newer field revision exists but is still building.
- [ ] Add diagnostics for `queueWaitMs`, `workerComputeMs`, `transferMs`, `outputBytes`, and `glyphCount`.
- [ ] Keep vector uploads chunked and cancellable.

Tests:

- vector lane does not synchronously call `buildVectorGlyphTransforms` or `buildVectorGlyphColors` from React render;
- stale glyph result remains visible while the next compatible job runs;
- obsolete vector jobs do not upload to GPU;
- vector lane diagnostics include queue wait and worker compute separately;
- vector worker imports only pure model code, not React or scheduler code.

Acceptance:

- a full FEM field with several vector layers no longer serializes every glyph build behind one worker;
- pan/orbit remains responsive while glyph jobs are queued and running;
- final glyph quality and count match the requested full-quality settings.

### Phase 4: Topology Index And Region Overlay Lanes

Goal: keep topology and overlay builds off-main-thread and revision-keyed.

- [ ] Move topology index scheduling into the build engine topology lane.
- [ ] Add topology key tests that field changes do not rebuild topology indices.
- [ ] Add region overlay build model and worker if overlay derivation currently runs on the main thread.
- [ ] Cache topology indices by topology revision and target registry revision.
- [ ] Cache region overlay maps by topology revision, region revision, and overlay display mode.
- [ ] Preserve primitive/authored overlays while realized mesh-backed overlays are building when that state is semantically correct.
- [ ] Add diagnostics for topology index build counts, bytes, and adoption.

Tests:

- topology worker results are reused across field revisions;
- region overlay worker results are reused across field-only updates;
- topology index pending state does not synchronously build fallback indices in render;
- unmount releases topology cache references and worker jobs.

Acceptance:

- mesh topology does not rebuild because magnetization updates;
- region overlays no longer contribute large unbounded main-thread windows.

### Phase 5: Field Color Lane

Goal: move scalar/vector color mapping out of main-thread update paths.

- [ ] Identify current field-color build points in `Viewport3DScene.tsx`, field layers, and render-model helpers.
- [ ] Create pure field-color build model.
- [ ] Create field-color worker.
- [ ] Key field color buffers by topology revision, field revision, quantity, component, color map, range, target, and sampling.
- [ ] Keep color-range changes separate from topology changes.
- [ ] Use cached statistics when available; request backend-provided min/max/histogram resources when the frontend lacks them.
- [ ] Upload color attributes through the GPU upload manager.

Tests:

- color map/range change does not rebuild topology;
- field revision change rebuilds color buffers but reuses topology indices;
- color worker returns transferable buffers;
- color upload is chunked and abortable.

Acceptance:

- field-color dirty reasons cannot produce multi-second render windows;
- color quality matches the current visual output.

### Phase 6: GPU Upload Manager

Goal: prevent worker results from freezing the UI during WebGL adoption.

- [ ] Create upload ticket types for `BufferAttribute`, `InstancedBufferAttribute`, index buffers, and material/uniform-only updates.
- [ ] Implement upload manager with frame-budgeted slices.
- [ ] Integrate vector glyph matrix/color uploads.
- [ ] Integrate scalar field color uploads.
- [ ] Integrate topology/overlay index uploads where applicable.
- [ ] Add diagnostics for upload slices and frame budget overruns.
- [ ] Add tests using fake timers and fake frame callbacks.

Upload policy:

```ts
export interface Viewport3DGpuUploadPolicy {
  readonly targetFrameBudgetMs: 3;
  readonly maxFrameBudgetMs: 5;
  readonly maxBytesPerSlice: number;
  readonly maxItemsPerSlice: number;
}
```

Acceptance:

- no single upload slice exceeds the budget in tests;
- obsolete uploads are cancelled before mutating visible geometry;
- visible buffers swap atomically after upload completion.

### Phase 7: React/R3F Layer Cleanup

Goal: make R3F layers stable consumers of build-engine results.

- [ ] Audit each 3D layer for large `useMemo`, derived typed arrays, and render-time loops.
- [ ] Move heavy derivation into build lanes.
- [ ] Replace large state with refs, cache handles, or external-store snapshots.
- [ ] Ensure layer cleanup releases cache references.
- [ ] Ensure material/uniform-only changes avoid geometry rebuilds.
- [ ] Keep `CanvasLifecycleProbe` and dirty reasons accurate.

Tests:

- source-level tests reject known synchronous builder calls in layer render paths;
- layer unmount releases cache references;
- quantity switch does not recreate topology geometry;
- camera-only interaction does not schedule build jobs.

Acceptance:

- React render cost is not proportional to mesh element count or vector glyph count.

### Phase 8: Server-Side Derived Visualization Resources

Goal: prepare the production path for very large models where browser workers are not enough.

This phase is not required to fix the current 60k-node case, but it is required for a professional large-model architecture.

Candidate API resources:

```text
GET /v2/sessions/current/visualization/derived/topology-index
GET /v2/sessions/current/visualization/derived/field-colors
GET /v2/sessions/current/visualization/derived/vector-glyphs
GET /v2/sessions/current/visualization/derived/region-overlays
```

Rules:

- derived resources are keyed by the same semantic build keys as browser jobs;
- server-side derived resources are optional accelerators, not alternate semantics;
- browser workers remain the fallback;
- binary data plane carries derived buffers;
- provenance records which side built the buffer.

Backend/API work must update:

```text
docs/specs/resource-first-control-room-api-v2.md
crates/fullmag-api OpenAPI/schema surfaces
apps/control-room typed API facade
resource hook tests
```

Acceptance:

- browser and server derived buffers produce equivalent visual output for the same key;
- the browser can choose server-derived buffers when available without changing layer semantics.

### Phase 9: Diagnostic Recorder Integration

Goal: make every freeze explainable.

- [ ] Extend diagnostic records with build-engine job records.
- [ ] Extend `record-diagnostics.mjs` summaries with lane breakdowns.
- [ ] Add suspect report sections:
  - build queue bottleneck;
  - worker compute bottleneck;
  - transfer bottleneck;
  - main-thread upload bottleneck;
  - React rerender bottleneck;
  - GPU driver stall suspicion;
  - stale-visible revision summary.
- [ ] Add a scenario that captures startup, first full 3D ready state, one camera pan, one orbit, one quantity/field update, and idle.
- [ ] Ensure diagnostic recording itself has bounded memory.

Acceptance:

- after a freeze, the artifact identifies whether the dominant cost was queue, worker compute, transfer, upload, React, request/decode, or GPU driver stall.

### Phase 10: Production Hardening

Goal: make the system safe to ship and maintain.

- [ ] Add memory stress tests for repeated 3D mount/unmount.
- [ ] Add quantity-switch stress tests.
- [ ] Add camera-interaction stress tests while worker jobs are running.
- [ ] Add browser smoke that asserts:
  - canvas visible;
  - WebGL context not lost;
  - drawing buffer non-zero;
  - no multi-second long task;
  - no idle render loop after settling.
- [ ] Remove obsolete ad hoc schedulers after their lanes move to the build engine.
- [ ] Document feature flags, owners, and removal criteria.
- [ ] Update frontend v2 performance docs if the architecture becomes canonical.

Acceptance:

- all control-room tests, lint, typecheck, and browser viewport smoke pass;
- diagnostic run on the CofeB rings case shows no browser freeze during full 3D build/update;
- final visual screenshot matches the full-quality baseline.

## Validation Gates

### Unit And Static Gates

Run during iteration:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
pnpm --dir apps/control-room exec vitest run src/kernel/performance
```

Final frontend gates:

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
```

### Browser Gates

Required for any viewport lifecycle change:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Required for the real case:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Expected final diagnostic properties:

- max startup/update long task under `100 ms` for Fullmag-owned work;
- no repeated long animation frames during idle;
- no unbounded build queue;
- no synchronous large buffer build in React render;
- no WebGL context loss;
- no missing full-quality layers in final screenshot;
- viewport idle frames settle to zero after all dirty work completes.

If browser/GPU driver work still exceeds the threshold, the artifact must show that Fullmag has already yielded all controllable work and that the remaining block is in GPU upload/driver/browser internals. Even then, upload chunking and buffer adoption must be revisited before accepting the result.

## Risk Register And Fixes

| Risk | Why it matters | Required mitigation |
|---|---|---|
| Worker pool saturates CPU | UI can still feel frozen if workers consume all cores | small lane concurrency, `maxTotalWorkers`, diagnostics for queue vs compute |
| Worker transfer doubles memory | large typed arrays can spike memory | transfer ownership where safe, avoid duplicate copies, cache byte accounting |
| Stale visuals mislead the user | previous field may be displayed while new field builds | explicit displayed revision state, subtle updating marker, diagnostics record stale reason |
| GPU upload becomes new freeze | workers finish but main thread blocks on buffer adoption | upload manager with per-frame budget and abortable tickets |
| React rerenders on buffer identity churn | external-store snapshots can still churn if wrong | referentially stable small snapshots, no large arrays in React state |
| Diagnostics cause overhead | forensic logging can become the bottleneck | bounded logs, dropped-event counts, disabled/sampled production profile |
| Server-derived buffers fork semantics | backend accelerator could drift from browser workers | same build keys, equivalence tests, provenance field |
| Cache keeps old FEM buffers alive | memory leaks grow across quantity switches | reference counts, eviction policy, memory stress tests |
| Feature flags become permanent | transitional code accumulates | owner, removal condition, tests for canonical path |
| Quality regresses silently | visual layers disappear under pressure | screenshot/buffer checks and final full-quality acceptance gate |

## Design Alternatives Considered

### Alternative A: Keep Ad Hoc Workers Per Layer

This is the smallest local change, but it does not scale. Each layer would own its own queue, cancellation, diagnostics, cache, and upload policy. We already see the failure mode: vector glyphs improved but wall-time queues and attribution remain weak.

Decision: reject as the long-term architecture. Use only as a transitional step while moving lanes into the engine.

### Alternative B: One Central Build Engine In The Browser

This is the recommended first production architecture. It centralizes scheduling, cache keys, cancellation, stale presentation, diagnostics, and upload budgets while staying inside the existing frontend v2 module boundary.

Decision: implement first.

### Alternative C: Server-Side Postprocessing First

This is the most scalable end-state for very large cases, but it requires API/OpenAPI/backend work before fixing the current browser freeze. It also does not remove the need for browser upload scheduling.

Decision: design for it now, implement after the browser build engine proves the contract.

## First Draft Stress Review

After writing the first version of this plan, the main loopholes were:

1. Moving compute to workers does not by itself prevent freezes because GPU upload can still block the main thread.
2. A worker pool can make interaction worse if it uses too many workers.
3. Stale-while-rebuild can become scientifically misleading if the visible field revision is not explicit.
4. Diagnostic wall time can be misread as main-thread blocking if queue time and worker compute time are not separated.
5. Cache reuse can create memory leaks if buffer ownership is not reference-counted.
6. Server-side derived resources can create a second visualization semantics path if they are not keyed by the same build contract.
7. React can still rerender too much if snapshots are not referentially stable.

The plan was corrected by adding:

- a dedicated GPU upload manager;
- strict lane concurrency and total worker caps;
- explicit stale state categories;
- structured diagnostic timing fields;
- reference-counted derived buffer cache;
- same-key browser/server derived resource contract;
- `useSyncExternalStore` snapshots with small immutable status objects.

## Final Confidence Review

I am confident this is the correct production direction for Fullmag because it matches the measured failure mode and the frontend v2 architecture:

- it preserves the single unified viewport;
- it keeps FDM/FEM differences inside adapters and render-model inputs;
- it separates topology from field updates;
- it keeps idle rendering dirty-driven;
- it keeps large typed arrays out of React state;
- it makes memory/resource ownership explicit;
- it does not trade visual quality for speed;
- it creates a route to server-side postprocessing without forking semantics.

The plan is not allowed to claim success until the CofeB rings diagnostic proves the browser no longer freezes during full 3D startup and update, and the final screenshot confirms that full-quality visualization remains intact.

## Execution Order

Recommended execution:

1. Phase 0 baseline and guardrails.
2. Phase 1 keys/store.
3. Phase 2 scheduler/pool.
4. Phase 3 vector glyph lane.
5. Run the CofeB rings diagnostic.
6. Phase 6 GPU upload manager if upload/adoption remains visible in diagnostics.
7. Phase 4 topology/overlay lanes.
8. Phase 5 field color lane.
9. Phase 9 recorder integration.
10. Phase 10 hardening.
11. Phase 8 server-side derived resources if large-model diagnostics still exceed browser-worker budgets.

This order attacks the measured bottleneck first while building the permanent architecture instead of another one-off patch.

