# Control Room Viewport 3D Build Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zbudowac produkcyjny silnik budowania wizualizacji 3D dla `apps/control-room`, tak aby pelna jakosc FEM/FDM 3D ladowala sie, przebudowywala i aktualizowala bez mrozenia glownego watku przegladarki.

**Architecture:** Wprowadzamy warstwe `Viewport3DVisualizationBuildEngine` pomiedzy resource hooks/render-model a warstwy R3F. Silnik ma revision-keyed job graph, bounded worker-pool lanes, derived-buffer cache, stale-while-rebuild presentation, frame-budgeted GPU upload manager i strukturalna diagnostyke. Jedno R3F `<Canvas frameloop="demand">` zostaje zachowane; jakosc wizualizacji nie jest zmniejszana.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Playwright/Chromium diagnostics, Three.js/R3F, Web Workers, Transferable typed arrays, Fullmag v2 resource-first API facade, Diagnostic Recorder, existing viewport dirty-frame diagnostics.

---

## 1. Executive Decision

Nie naprawiamy freezow przez wylaczanie warstw, obnizanie gestosci glyphow, upraszczanie mesh wireframe, ukrywanie overlayow albo degradowanie HUD. Te flagi zostaja narzedziem diagnostycznym, nie produkcyjnym rozwiazaniem.

Produkcyjny kierunek to oddzielenie:

```text
resource hooks / binary resources
  -> domain adapters
  -> semantic render-model inputs
  -> viewport 3D build engine
  -> worker-pool build lanes
  -> derived-buffer cache
  -> frame-budgeted GPU upload manager
  -> R3F resource owners
  -> one demand-rendered canvas
```

Glowny watek ma odpowiadac za interakcje, React, male snapshoty stanu, WebGL resource adoption i submit draw calls. Nie moze synchronicznie budowac duzych indeksow topologii, kolorow pola, macierzy glyphow, region overlay maps, mesh-quality maps, dekodow binarnych ani duzych buforow geometrii.

W profesjonalnych narzedziach symulacyjnych UI jest control room nad pipeline'em wynikow i postprocessingu. Nie musi znac szczegolow solvera, ale musi miec jasny kontrakt: co jest aktualna fizycznie rewizja, co jest zbudowanym buforem wizualizacji, co jest tylko w trakcie uploadu, i co nadal jest poprzednim widocznym stanem. Taki sam rozdzial wprowadzamy tutaj.

## 2. What We Know From Diagnostics

Ostatnia pelna diagnostyka zimnego przypadku FEM byla uruchamiana przez:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Najwazniejszy artefakt:

```text
.fullmag/reports/cofeb-rings-relax-diagnostics/browser/2026-06-24T10-23-22-498Z-viewport-3d
```

Zaobserwowany przypadek:

- mesh mial okolo `59620` nodes, `342415` tetrahedra, `92144` boundary faces;
- finalny screenshot pokazal pelna wizualizacje z mesh-ready state, airbox, region overlays i orientation HUD;
- maksymalny main-thread long task wynosil okolo `14374 ms`;
- maksymalna long animation frame miala okolo `1469 ms`, z blokowaniem okolo `1418 ms`;
- najdluzsze okno viewport frame mialo okolo `15049.6 ms`;
- dirty reasons zawieraly `vector-glyph-material`, `field-colors`, `region-mesh-overlay`;
- vector glyph build wall times wystepowaly miedzy okolo `9234.9 ms` i `233.5 ms`;
- topology resource path mial okolo `1654 ms`, lacznie z transportem i decode;
- vector glyph work jest juz czesciowo poza main thread, ale kilka niezaleznych buildow nadal serializuje sie przez jeden worker/client path;
- nadal istnieje nie w pelni wyjasniony multi-second freeze, wiec plan musi poprawic nie tylko scheduler, ale tez atrybucje kosztow.

Interpretacja: problemem nie jest sama jakosc 3D. Problemem jest brak centralnego wlasciciela kosztownych faz wizualizacji, brak wspolnego key/cancel/cache/upload contract i zbyt slaba diagnostyka rozrozniajaca queue wait, worker compute, transfer, main adoption, GPU upload oraz React rerender.

## 3. Non-Negotiable Quality Contract

Te punkty sa twardym kontraktem. Kazda implementacja, ktora je lamie, jest regresja.

1. Pelna jakosc wizualizacji zostaje domyslnym celem.
2. Mesh surfaces, wireframes, vectors, scalar colors, region overlays, airbox, HUD, bounds, selection i dimension frame nie sa wyciszane jako optymalizacja.
3. Flagi wylaczajace warstwy moga istniec tylko jako narzedzia diagnostyczne i musza byc opisane jako diagnostyczne.
4. Field update nie moze przebudowywac topologii, jesli topology revision sie nie zmienil.
5. Camera orbit, pan, zoom, hover i menu musza pozostac responsywne w czasie budowania buforow.
6. Viewport pozostaje jednym R3F canvasem z dirty-driven renderingiem.
7. Idle viewport frames po ustabilizowaniu zasobow musza zejsc do zera.
8. Large typed arrays nie moga mieszkac w React state.
9. Kazdy worker, observer, event listener, object URL, WebGL geometry/material/texture i derived typed array musi miec wlasciciela oraz release trigger.
10. Status "gotowe" wolno pokazac dopiero wtedy, gdy widoczna rewizja, zbudowana rewizja i uploadowana rewizja sa jawnie spojne.
11. Stale previous field moze byc widoczny podczas budowania nowej rewizji tylko z explicit `stale-physical` state w diagnostyce i UI.
12. Kazdy multi-second freeze musi byc wyjasnialny z artefaktu diagnostycznego, bez zgadywania.

## 4. Scope Boundaries

### In Scope

- Build engine dla viewportu 3D.
- Stable semantic build keys.
- Bounded scheduler i worker pool.
- Vector glyph lane productionization.
- Topology-index lane.
- Region-overlay lane.
- Field-color lane.
- Derived-buffer cache.
- Frame-budgeted GPU upload manager.
- Diagnostic Recorder records i summary.
- Browser diagnostics for CofeB rings case.
- Memory/resource lifecycle hardening.
- Future-ready contract dla opcjonalnych server-side derived visualization resources.

### Out Of Scope For First Production Slice

Te elementy sa zaprojektowane w kontrakcie, ale nie sa wymagane do pierwszego mierzalnego zwyciestwa nad obecnym 60k-node przypadkiem:

- pelne backendowe generowanie wszystkich derived visualization buffers;
- nowy publiczny OpenAPI endpoint dla kazdej derived resource;
- multi-view, split viewport albo wiele WebGL canvasow;
- zmiana solvera lub jakosci danych fizycznych;
- zmiana globalnej architektury workspace poza viewport/build diagnostics.

## 5. Current Implementation State In This Branch

Ten plan jest rownoczesnie dokumentem docelowym i trackerem wykonywania. Aktualny branch zawiera juz pierwsze elementy.

Completed:

- [x] `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineTypes.ts`
- [x] `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.ts`
- [x] `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineStore.ts`
- [x] `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.ts`
- [x] tests for stable key behavior, scheduler dedupe, latest-wins abort and store snapshot stability;
- [x] vector glyph requests can carry build-engine keys and latest-wins group keys;
- [x] vector glyph pure build model remains separate from React/R3F;
- [x] `useViewport3DSceneModel.ts` passes semantic topology/field/visualization revisions into render-model build references;
- [x] `VectorFieldLayer.tsx`, `FallbackTopologyMeshLayer.tsx`, `MeshPartLayer.tsx`, and `BoundsLayers.tsx` pass or consume vector build references where available.
- [x] real bounded vector worker pool with max two worker slots and tests for two concurrent builds.

Still not complete:

- [x] explicit worker fallback diagnostics;
- [x] stale-compatible and stale-physical cache policy;
- [ ] field-color lane;
- [ ] topology-index and region-overlay lanes;
- [ ] GPU upload manager;
- [x] build-engine records bridged into Diagnostic Recorder while viewport is mounted;
- [x] structured build-engine records in exported Diagnostic Recorder artifacts;
- [ ] CofeB full diagnostic after the new architecture lands;
- [ ] memory stress and idle performance gates.

## 6. Target Architecture

### 6.1 Resource Input Layer

Only existing typed resource paths may feed the viewport:

- `ControlRoomApi`;
- resource hooks;
- binary resource helpers;
- realtime invalidation bridge;
- render-model adapters.

R3F layers must not call `fetch()` and must not construct raw session endpoint strings outside the typed API facade.

### 6.2 Semantic Render-Model Layer

`useViewport3DSceneModel.ts` and `viewport3dRenderModel.ts` convert raw resources into small semantic inputs:

- `sessionId`;
- `domainId`;
- `topologyRevision`;
- `fieldRevision`;
- `targetVisualizationRevision`;
- `quantityId`;
- `component`;
- `scopeKind`;
- `scopeId`;
- style/sampling revisions;
- stable geometry/field references.

This layer may compute small scalar metadata. It must not derive large render buffers.

### 6.3 Build Engine Facade

Create/complete:

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

- normalize expensive requests into stable semantic keys;
- dedupe identical pending jobs;
- cancel obsolete jobs by group;
- separate queue wait from worker compute;
- expose small `useSyncExternalStore` snapshots;
- preserve previous compatible buffers while new buffers build;
- send structured records to Diagnostic Recorder;
- own cleanup for derived buffers that are not resource-cache owned.

### 6.4 Worker Pool Runtime

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/
  viewport3dWorkerPoolTypes.ts
  viewport3dWorkerPool.ts
  viewport3dWorkerPoolDiagnostics.ts
```

Requirements:

- bounded per-lane concurrency;
- bounded global worker count;
- FIFO inside each lane;
- latest-wins cancellation for obsolete revisions;
- explicit abort propagation;
- no orphaned pending promises;
- transfer typed-array ownership where safe;
- idle termination;
- structured fallback record when worker is unavailable.

Default policy:

```ts
export interface Viewport3DWorkerPoolPolicy {
  readonly topologyIndexWorkers: 1;
  readonly binaryDecodeWorkers: 1 | 2;
  readonly fieldColorWorkers: 1 | 2;
  readonly vectorGlyphWorkers: 1 | 2;
  readonly regionOverlayWorkers: 1;
  readonly meshQualityWorkers: 1;
  readonly maxTotalWorkers: 4;
}
```

`navigator.hardwareConcurrency` moze tylko obnizyc limit. Nie moze automatycznie podbijac liczby workerow do liczby rdzeni.

### 6.5 Derived Buffer Cache

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/cache/
  viewport3dDerivedBufferCache.ts
  viewport3dCacheKey.ts
  viewport3dCacheEviction.ts
```

Cache entry categories:

- `ready-current`: bufor odpowiada aktualnie wyswietlanej rewizji;
- `stale-compatible`: poprzedni bufor jest wizualnie bezpieczny podczas budowania nowego stylu lub uploadu;
- `stale-physical`: poprzednia rewizja fizyczna pola jest nadal widoczna, bo nowa rewizja sie buduje;
- `invalid`: bufor nie moze byc pokazany, bo semantyka topologii/targetu sie zmienila.

Cache rules:

- entries immutable after ready;
- reference counted by layer adoption;
- estimated bytes tracked;
- eviction by revision, memory pressure and module unmount;
- no large arrays in React state;
- release path covered by tests.

### 6.6 GPU Upload Manager

Create:

```text
apps/control-room/src/modules/viewport-3d/build-engine/gpu/
  viewport3dGpuUploadTypes.ts
  viewport3dGpuUploadManager.ts
  viewport3dGpuUploadDiagnostics.ts
```

Upload pipeline:

```text
worker result
  -> derived-buffer cache
  -> upload ticket
  -> per-frame upload slices
  -> atomic visible-handle adoption
  -> demand render invalidation
```

Policy:

```ts
export interface Viewport3DGpuUploadPolicy {
  readonly targetFrameBudgetMs: 3;
  readonly maxFrameBudgetMs: 5;
  readonly maxBytesPerSlice: number;
  readonly maxItemsPerSlice: number;
}
```

No layer may perform unbounded `setMatrixAt`, `needsUpdate`, `BufferAttribute` replacement or geometry rebuild loop in a single frame for large data.

### 6.7 R3F Layer Bridge

R3F layers become consumers of handles and small state:

- `VectorFieldLayer.tsx` consumes glyph buffer handles and upload status;
- scalar/field-color layers consume color buffer handles;
- topology/mesh/overlay layers consume topology and overlay handles;
- HUD/bounds/dimension remain lightweight and interruptible;
- layer cleanup releases cache refs and upload tickets.

Render functions stay pure and small. Expensive build requests are effects or external-store transitions, not render calculations.

### 6.8 Diagnostic Recorder Integration

Every expensive job must produce a record shaped like:

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

Diagnostic Recorder summary must be able to answer:

- which lane dominated wall time;
- whether UI freeze was queue, worker compute, transfer, main adoption, GPU upload, React rerender, request/decode or browser/GPU driver;
- whether visible buffers were stale;
- how many workers were active;
- how many bytes were allocated, transferred and uploaded;
- whether idle frames continued after settling.

## 7. Stable Build Key Contract

Every expensive derived buffer key must include exactly the semantic inputs that affect it.

Base key parts:

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
  readonly targetVisualizationRevision: string;
  readonly styleRevision: string;
  readonly samplingRevision: string;
  readonly algorithmVersion: number;
}
```

Rules:

- camera-only change cannot alter topology, field-color, vector-glyph, region-overlay or mesh-quality keys;
- field revision changes field-color and vector-glyph keys, not topology-index keys;
- topology revision invalidates topology-dependent keys;
- target visualization changes affect only the lanes whose visible target/style/scope changed;
- algorithm version changes invalidate corresponding derived buffers;
- cache keys are portable enough that future server-derived resources can use the same contract.

## 8. Implementation Phases

### Phase 0: Baseline And Guardrails

Goal: freeze the measured failure mode before more architecture work.

Files:

- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Modify: `apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.ts`
- Test: `apps/control-room/src/kernel/performance/diagnosticRecorderScript.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`

Steps:

- [ ] Add a diagnostic scenario label `cofeb-rings-relax-full-3d-cold`.
- [ ] Add parser assertions for max long task, max LOAF, max viewport frame window and top build measures from a saved artifact summary.
- [ ] Add source-level tests proving viewport layers do not call known large builders from render or broad `useMemo`.
- [ ] Add a diagnostic distinction between worker wall time and main-thread blocking time.
- [ ] Run:

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
```

Acceptance:

- current bottleneck is reproducible;
- worker wall time is not automatically reported as main-thread blocking;
- no implementation change can claim improvement without before/after artifacts.

### Phase 1: Build Engine Types, Keys, Store

Goal: central contract without changing visuals.

Files:

- Create/complete: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineTypes.ts`
- Create/complete: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.ts`
- Create/complete: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineStore.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineStore.test.ts`

Steps:

- [x] Define lane, state, key, request, result and diagnostic types.
- [x] Add stable key builders for topology index, field color, vector glyph and region overlay.
- [x] Test camera-only revisions do not alter heavy-build keys.
- [x] Test field revisions alter field-color/vector-glyph keys, not topology-index keys.
- [x] Test topology revisions invalidate topology-dependent keys.
- [x] Add `useSyncExternalStore`-compatible build-engine snapshots.
- [x] Test snapshots stay referentially stable when small status data does not change.

Acceptance:

- no visual behavior changed;
- key tests prevent camera interaction from scheduling heavy builds;
- snapshots contain no large typed arrays.

### Phase 2: Scheduler And Worker Pool

Goal: replace ad hoc queues with one bounded, observable, abortable scheduling layer.

Files:

- Create/complete: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPoolTypes.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPool.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPoolDiagnostics.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPool.test.ts`

Steps:

- [x] Implement scheduler dedupe for identical pending jobs.
- [x] Implement latest-wins cancellation by group.
- [x] Implement per-lane concurrency limits.
- [x] Implement dispose/unmount abort for pending jobs.
- [x] Implement generic worker pool leases with max pool size and active job counts.
- [x] Add pool tests for max two vector workers, lease release, dispose and idle termination.
- [x] Add explicit fallback diagnostic when Worker is unavailable.
- [ ] Add user-facing fallback state snapshot if a worker lane permanently falls back.
- [x] Add diagnostics for `queuedAt`, `startedAt`, `finishedAt`, `abortedAt`, `fallbackReason`.

Core scheduler contract:

```ts
export interface Viewport3DBuildScheduler {
  readonly schedule: <TResult>(
    request: Viewport3DBuildRequest,
    runner: Viewport3DBuildRunner<TResult>,
    options?: Viewport3DBuildScheduleOptions,
  ) => Promise<TResult>;
  readonly abortObsolete: (scope: Viewport3DBuildAbortScope) => void;
  readonly dispose: () => void;
}
```

Acceptance:

- no lane can spawn unbounded workers;
- every pending job is observable, abortable and attributed;
- obsolete revisions reject before upload/adoption;
- worker fallback is recorded, not silent.

### Phase 3: Vector Glyph Lane Productionization

Goal: remove the current vector-glyph bottleneck while preserving full glyph quality.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`

Steps:

- [x] Route vector glyph builds through the build-engine scheduler.
- [x] Keep `vectorGlyphBuildModel.ts` pure and worker-safe.
- [x] Add vector job keys containing topology revision, field revision, scope, style and sampling inputs.
- [x] Dedupe identical vector glyph builds across layers.
- [x] Replace single `VectorGlyphWorkerClient` worker with bounded pool, default max `2`.
- [x] Add test: two different concurrent vector glyph jobs use two worker instances, not one serialized worker.
- [x] Add test: three concurrent vector glyph jobs create no more than two workers.
- [x] Preserve last good compatible glyph buffers while a new request is queued/running.
- [x] Mark previous-field glyphs as `stale-physical` when a newer field revision exists.
- [x] Add diagnostics for queue wait, worker compute, output bytes and glyph count.
- [ ] Add measured transfer timing beyond the current zero-value placeholder when transfer/upload manager lands.
- [x] Prove abort prevents obsolete glyph result from uploading or replacing visible buffers.

Acceptance:

- full FEM visualization no longer queues all vector builds behind one worker;
- pan and orbit remain responsive during vector builds;
- glyph count, scale, colors and visual quality match the baseline full-quality settings;
- diagnostics show whether remaining cost is queue, worker compute, transfer or upload.

### Phase 4: Derived Buffer Cache And Stale Presentation

Goal: keep the UI interactive and scientifically honest while new buffers build.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dCacheKey.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dCacheEviction.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.test.ts`

Steps:

- [x] Implement cache entries with `ready-current`, `stale-compatible`, `stale-physical`, `invalid`.
- [x] Add reference counting for adopted layer handles.
- [x] Track estimated bytes per entry.
- [x] Evict by explicit release/refcount and memory pressure threshold.
- [x] Add revision-scoped eviction for stale topology/field generations.
- [x] Add stale-state snapshots that expose displayed revision and target revision.
- [x] Add tests for release on layer unmount.
- [x] Add tests for field-only update preserving compatible topology cache.
- [x] Add tests that invalid topology cannot be displayed after topology semantics changed.

Acceptance:

- previous full-quality buffers can remain visible without freezing the UI;
- stale physical state is explicit;
- cache cannot silently leak old FEM buffers across quantity switches.

### Phase 5: Topology Index And Region Overlay Lanes

Goal: keep topology and overlay derivation off the main thread and independent from field updates.

Files:

- Create/modify: `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexModel.ts`
- Create/modify: `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexWorker.ts`
- Create: `apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildModel.ts`
- Create: `apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildWorker.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/RegionMeshOverlayLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Test: topology/region overlay model and lane tests next to implementation files.

Steps:

- [x] Identify current topology-index derivation points.
- [x] Move topology-index build to `topology-index` lane.
- [x] Add key tests proving field revision changes do not rebuild topology.
- [ ] Move region overlay face/group derivation to `region-overlay` lane where it is currently main-thread heavy.
- [x] Extract mesh-backed region overlay build model and worker wrapper under `region-overlays/`.
- [x] Route `RegionMeshOverlayLayer` through the region overlay build-model boundary.
- [ ] Cache topology indices by topology revision and target registry revision.
- [ ] Cache region overlays by topology revision, region revision and overlay display mode.
- [x] Cache mesh-backed region overlay geometry buffers by topology object and resolved region/part selection with bounded eviction.
- [ ] Preserve authored primitive overlays while realized mesh overlays build when semantically valid.
- [x] Add diagnostics for topology index build count, bytes, queue wait and adoption.

Acceptance:

- magnetization updates do not rebuild mesh topology;
- region overlays do not produce unbounded main-thread windows;
- airbox wireframe visual contract remains intact.

### Phase 6: Field Color Lane

Goal: move scalar/vector color mapping out of main-thread update paths.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts`
- Create: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildWorker.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.test.ts`

Steps:

- [x] Identify all current `field-colors` dirty reasons and buffer build points.
- [x] Route chunked full-domain field color builds through `field-color` build-engine scheduler with semantic keys and diagnostics.
- [x] Create pure field-color build model accepting field buffer, topology/sample mapping, color map and range.
- [x] Create worker wrapper returning transferable color buffers.
- [x] Key color buffers by topology revision, field revision, quantity, component, color map, range, target and sampling.
- [x] Reuse topology/cache handles across field color rebuilds.
- [x] Use backend-provided stats when available; compute stats in worker only when absent.
- [x] Send resulting buffers to GPU upload manager, not direct layer adoption.

Acceptance:

- field-color update cannot produce multi-second React/R3F render windows;
- color quality and range semantics match current visual output;
- topology is not rebuilt for color-only changes.

### Phase 7: GPU Upload Manager

Goal: prevent worker results from causing a new main-thread freeze during WebGL adoption.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadTypes.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadDiagnostics.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.test.ts`

Steps:

- [x] Define upload tickets for `BufferAttribute`, `InstancedBufferAttribute`, index buffers and material/uniform-only updates.
- [x] Implement requestAnimationFrame-driven upload queue.
- [x] Split uploads by byte and item count budgets.
- [x] Abort obsolete upload tickets before visible mutation.
- [x] Atomically swap visible handles after upload completion.
- [x] Record `mainUploadMs`, `uploadBytes`, `uploadChunks`, `uploadFrames`, `budgetExceeded`.
- [x] Add fake-timer tests proving no upload slice exceeds budget in controlled runs.
- [x] Integrate vector glyph uploads first.
- [x] Integrate field color uploads next.
- [ ] Integrate topology/overlay uploads where applicable.

Acceptance:

- no single Fullmag-owned upload slice exceeds the configured budget in tests;
- obsolete uploads cannot mutate visible geometry;
- viewport only invalidates render when a visible handle changes.

### Phase 8: React/R3F Layer Cleanup

Goal: make R3F layers stable consumers instead of large-data builders.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx`
- Test: source-level viewport layer tests.

Steps:

- [ ] Audit each 3D layer for large `useMemo`, large typed array creation and render-time loops.
- [ ] Move heavy derivation to build lanes.
- [ ] Replace large React state with refs, cache handles or external-store snapshots.
- [ ] Ensure cleanup releases cache refs and upload tickets.
- [ ] Ensure material/uniform-only changes avoid geometry rebuilds.
- [ ] Ensure camera-only interaction schedules no build jobs.
- [ ] Ensure quantity switch does not recreate topology geometry.
- [ ] Keep `CanvasLifecycleProbe` and dirty reasons accurate.

Acceptance:

- React render cost is not proportional to mesh element count or vector glyph count;
- selection and camera updates stay cheap;
- no layer owns another layer's disposal.

### Phase 9: Diagnostic Recorder And UI Surface

Goal: make every freeze explainable from logs without manual console spelunking.

Files:

- Modify: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes.ts`
- Modify: `apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.ts`
- Modify: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderDialog.tsx`
- Modify: `apps/control-room/src/modules/footer/DiagnosticRecorderFooterPanel.tsx`
- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Test: recorder/controller/dialog/script tests next to those files.

Steps:

- [ ] Add build-engine record type to diagnostic artifacts.
- [x] Add lane breakdown summary to `record-diagnostics.mjs`.
- [ ] Add suspect sections: queue bottleneck, worker bottleneck, transfer bottleneck, upload bottleneck, React rerender bottleneck, resource/decode bottleneck, GPU-driver suspicion.
- [ ] Add visible stale revision summary.
- [ ] Add worker pool status to diagnostic dialog/tools UI.
- [ ] Keep UI lightweight: no live charts that create their own sampling overhead.
- [ ] Bound diagnostic log memory and record dropped-event counts.

Acceptance:

- after a freeze, artifact names the dominant cost category;
- UI in tools exposes state, but the recorder works from boot without clicks;
- diagnostic recording itself is not a performance problem.

### Phase 10: CofeB Full Diagnostic Loop

Goal: prove the architecture solves the actual reported freeze.

Files:

- Modify: `justfile` only if command ergonomics need a stable recipe.
- Modify: `apps/control-room/scripts/record-diagnostics.mjs` if the scenario needs richer automation.
- Artifact path pattern: `.fullmag/reports/cofeb-rings-relax-diagnostics/browser/<timestamp>-viewport-3d`

Steps:

- [ ] Run a short CofeB simulation capped to the current diagnostic scenario.
- [ ] Launch the frontend with diagnostic recorder enabled from boot.
- [ ] Capture startup, first 3D ready, camera pan, orbit, field/quantity update and idle window.
- [ ] Export full diagnostic artifact without manual browser clicks.
- [ ] Compare against baseline long task, LOAF, frame window, worker lane and upload timings.
- [ ] Capture final screenshot and assert full-quality layer presence.
- [ ] If a freeze remains, classify it before changing code again.

Command target:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Acceptance:

- no Fullmag-owned startup/update long task above `100 ms`;
- no multi-second long animation frame caused by Fullmag-owned work;
- final screenshot contains mesh, field colors, vector glyphs, region overlays, airbox and HUD;
- idle frames settle to zero after resources and uploads finish.

### Phase 11: Memory And Lifecycle Hardening

Goal: make repeated usage safe, not only the first load.

Files:

- Add/modify viewport memory stress tests under `apps/control-room/src/modules/viewport-3d/`.
- Modify resource tracker tests where needed.
- Modify diagnostic recorder tests for resource count reporting.

Steps:

- [ ] Add stress loop: mount 3D, load field, switch quantities, switch 3D/cross-section/plots, select/clear objects, unmount.
- [ ] Assert workers terminate after idle/unmount.
- [ ] Assert WebGL geometries/materials/textures return to expected baseline.
- [ ] Assert cache entries release references after layer unmount.
- [ ] Assert object URLs are revoked where binary/image resources are used.
- [ ] Assert no active 3D resource hooks remain when non-3D center tab is active.

Acceptance:

- no unbounded memory growth across repeated viewport usage;
- no hidden WebGL context remains mounted on non-3D tabs;
- context loss during startup is treated as a failure unless proven teardown-only.

### Phase 12: Optional Server-Side Derived Visualization Resources

Goal: prepare professional large-model scalability without forking semantics.

Candidate resources:

```text
GET /v2/sessions/current/visualization/derived/topology-index
GET /v2/sessions/current/visualization/derived/field-colors
GET /v2/sessions/current/visualization/derived/vector-glyphs
GET /v2/sessions/current/visualization/derived/region-overlays
```

Rules:

- same semantic build keys as browser workers;
- binary data plane for heavy buffers;
- provenance records browser-worker vs server-derived origin;
- browser workers remain fallback;
- server-derived buffers must pass equivalence tests against browser builders.

Files when this phase starts:

- `docs/specs/resource-first-control-room-api-v2.md`
- OpenAPI/schema surfaces in backend API crates
- generated frontend API facade
- resource hook tests
- viewport build-engine server-derived adapter

Acceptance:

- server-side buffers accelerate large cases without changing visible semantics;
- browser/server derived outputs are equivalent for the same key.

## 9. Production Diagnostics Schema

Every diagnostic artifact for this work must include these sections:

```text
viewport3dBuildSummary
  lanes[]
    lane
    jobs
    aborted
    obsoleteDropped
    queueWaitMaxMs
    workerComputeMaxMs
    transferMaxMs
    uploadMaxMs
    outputBytes
    itemCount

viewport3dVisibleRevisionSummary
  topologyRevision
  fieldRevision
  targetVisualizationRevision
  stalePhysicalTargets[]
  staleCompatibleTargets[]
  invalidSuppressedTargets[]

viewport3dResourceSummary
  workersActive
  workersCreated
  workersTerminated
  cacheEntries
  cacheBytesEstimated
  webglGeometryCount
  webglMaterialCount
  webglTextureCount

viewport3dInteractionSummary
  panMaxFrameMs
  orbitMaxFrameMs
  zoomMaxFrameMs
  dirtyReasons[]
  idleFramesAfterSettling
```

The summary must avoid dumping full buffers or unbounded event streams.

## 10. Testing Strategy

### Unit/Static Gates During Iteration

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
pnpm --dir apps/control-room exec vitest run src/kernel/performance
```

### Final Frontend Gates

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
```

### Browser Viewport Smoke

Required for viewport lifecycle changes:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

### Real Diagnostic Gate

Required before claiming performance success:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Expected final properties:

- canvas visible;
- WebGL context not lost;
- drawing buffer non-zero;
- no idle render loop;
- no Fullmag-owned multi-second long task;
- no missing full-quality 3D layer;
- no unbounded build queue;
- no topology rebuild from field-only update;
- no stale visible field without explicit stale state.

## 11. Risk Register

| Risk | Why it matters | Required mitigation |
|---|---|---|
| Worker pool saturates CPU | UI can still freeze if workers starve browser/main thread | small lane limits, `maxTotalWorkers`, queue diagnostics |
| Worker transfer doubles memory | typed arrays can spike memory | transfer ownership where safe, byte accounting, cache eviction |
| GPU upload becomes new freeze | worker results still need main-thread WebGL adoption | upload manager with per-frame budget and abortable tickets |
| Stale visuals mislead user | previous field may be displayed during new field build | explicit visible/target revision state and `stale-physical` marker |
| React rerenders from snapshot churn | external stores can still trigger render storms | referentially stable snapshots and primitive dependencies |
| Diagnostics become bottleneck | logging can create its own freeze | bounded records, dropped-event counters, disabled/sampled profiles |
| Server-derived resources drift | backend derived buffers could fork semantics | same keys, equivalence tests, provenance |
| Cache leaks old FEM data | quantity switches can retain large buffers | ref counts, release tests, memory stress |
| Feature flags become permanent | diagnostic switches can become product behavior | owner, removal condition, tests for canonical path |
| Quality silently regresses | "optimization" can hide layers | screenshot assertions and final layer-presence checks |

## 12. Banned Implementation Shortcuts

- Do not reduce vector glyph count as the primary fix.
- Do not hide region overlays to pass performance diagnostics.
- Do not replace field colors with a lower-quality preview without explicit staged/full state.
- Do not keep workers alive forever to avoid startup overhead.
- Do not move large typed arrays into Zustand or React state.
- Do not call API endpoints directly from viewport layers.
- Do not create another FDM/FEM-specific viewport fork.
- Do not add continuous `requestAnimationFrame` rendering while idle.
- Do not treat worker wall time as proof of main-thread blocking.
- Do not claim success from `typecheck` and unit tests alone.

## 13. Design Alternatives Considered

### Alternative A: Keep Ad Hoc Workers Per Layer

Smallest diff, but every layer owns its own queue, cancellation, cache, stale state, upload policy and diagnostics. This is exactly the class of failure we are seeing.

Decision: reject as production architecture. Accept only as transitional code while migrating lanes.

### Alternative B: One Browser-Side Build Engine

Centralizes keys, scheduling, cancellation, stale presentation, diagnostics and upload budgets while staying inside frontend v2 module boundaries.

Decision: implement first.

### Alternative C: Server-Side Postprocessing First

Best long-term path for very large models, but it requires API/backend work and still does not remove browser upload scheduling.

Decision: design compatibility now, implement after browser build-engine contract is proven.

### Alternative D: Lower Visual Quality During Startup

Could make first load look faster, but violates the primary requirement and hides the problem.

Decision: reject as optimization. Temporary progressive readiness is allowed only if final state is full quality and visible revision state is explicit.

## 14. First Draft Self-Review

Pierwsza wersja planu miala siedem luk:

1. "Move to workers" nie wystarcza, bo WebGL upload moze nadal blokowac main thread.
2. Worker pool bez limitow moglby pogorszyc interakcje.
3. Stale-while-rebuild moglby naukowo wprowadzac w blad.
4. Wall time moglby byc mylony z main-thread block time.
5. Cache moglby przeciekac duze FEM buffers.
6. Server-side derived resources moglyby stworzyc drugi kontrakt semantyczny.
7. React moglby nadal renderowac za duzo przez snapshot identity churn.

Korekta w finalnym planie:

- dodano GPU upload manager jako osobna faze;
- dodano male, jawne limity workerow;
- dodano `stale-compatible`, `stale-physical`, `invalid`;
- dodano rozdzial timingow na queue, worker, transfer, adopt i upload;
- dodano reference-counted derived-buffer cache;
- dodano wspolny build-key contract dla browser/server;
- dodano wymaganie stabilnych `useSyncExternalStore` snapshotow.

## 15. Final Confidence Review

Jestem pewien kierunku architektonicznego: freezing trzeba naprawic przez wlasnosc, harmonogram, cache, upload budget i diagnostyke, nie przez usuwanie wizualizacji.

Nie wolno jednak twierdzic, ze problem jest naprawiony, dopoki realny CofeB diagnostic tego nie potwierdzi. Warunkiem sukcesu jest artefakt, ktory pokazuje:

- brak Fullmag-owned multi-second main-thread freeze;
- pelna finalna jakosc 3D;
- jasne lane timings;
- brak idle render loop;
- brak WebGL context loss;
- brak memory/resource leak across repeated viewport use.

## 16. Recommended Execution Order

1. Finish Phase 2 worker pool.
2. Finish Phase 3 vector glyph lane productionization.
3. Run targeted vector/build-engine tests.
4. Run frontend gates.
5. Run viewport browser smoke.
6. Run CofeB full diagnostic.
7. If freeze remains, use artifact to choose between GPU upload manager, field-color lane, topology/overlay lane or React cleanup.
8. Implement GPU upload manager before accepting any upload/adoption freeze.
9. Move topology/region/field-color lanes.
10. Integrate Diagnostic Recorder summary and UI.
11. Add memory/lifecycle stress gates.
12. Only then consider server-side derived visualization resources.

This order attacks the measured bottleneck first, but keeps the permanent production architecture intact.

## 17. Professional Operating Model

Duzy profesjonalny pakiet symulacyjny nie traktuje widoku 3D jako miejsca, w
ktorym przypadkowe komponenty Reacta buduja geometryczne dane "przy okazji"
renderu. Widok jest konsumentem gotowych artefaktow prezentacji, a nie
monolitem, ktory jednoczesnie pobiera dane, dekoduje je, indeksuje, koloruje,
probkuje, uploaduje na GPU i obsluguje kamere.

Docelowy model operacyjny dla Fullmag:

```text
canonical session resources
  -> immutable resource revisions
  -> semantic render model
  -> background visualization build jobs
  -> immutable derived presentation buffers
  -> frame-budgeted GPU adoption
  -> demand-rendered R3F scene
  -> diagnostic artifact explaining every expensive phase
```

To jest ten sam typ rozdzialu odpowiedzialnosci, ktory ma sens w narzedziach
klasy COMSOL/ANSYS/ParaView: solver i dane fizyczne sa zrodlem prawdy,
postprocessing ma wlasny pipeline, a interaktywne UI nie jest zakladnikiem
jednej duzej synchronicznej operacji.

### 17.1 Priority Order During Runtime

Gdy aplikacja jest pod obciazeniem, priorytety sa stale:

1. Interakcja uzytkownika: pan, orbit, zoom, hover, menu, dialogi, zamykanie.
2. Bezpieczenstwo semantyczne: nie pokazac nowej rewizji jako gotowej, jezeli
   bufory nie odpowiadaja tej rewizji.
3. Pelna jakosc finalnej wizualizacji.
4. Szybkosc dojscia do finalnej wizualizacji.
5. Agresywne utrzymanie cache tylko wtedy, gdy nie powoduje memory pressure.

Jezeli dwa cele sa w konflikcie, interaktywnosc i semantyka wygrywaja nad czasem
do finalnego renderu. Jakosc finalna nie moze byc redukowana jako sposob na
"wygranie" benchmarku.

### 17.2 Three Classes Of Data

Plan rozroznia trzy klasy danych:

| Class | Example | Owner | Thread | Lifecycle |
|---|---|---|---|---|
| Canonical resource | mesh topology, field vector, visualization state | resource cache/API hooks | main + binary decode path | revision-based |
| Derived presentation buffer | glyph matrices, color buffer, region overlay index | build engine cache | worker first, main adopt | key/ref-count based |
| GPU handle | `BufferGeometry`, `BufferAttribute`, material, texture | R3F layer/resource tracker | main/WebGL only | layer unmount or handle replacement |

Blad produkcyjny to mieszanie tych klas, np. trzymanie `Float32Array` z polem w
React state, budowanie glyph matrices w komponencie R3F albo traktowanie WebGL
geometry jako cache zasobu fizycznego.

### 17.3 Viewport As A Consumer, Not A Builder

R3F scene ma robic trzy rzeczy:

- adoptowac gotowe handle;
- invalidowac demand frame z opisanym dirty reason;
- zwalniac zasoby po zmianie handle albo unmount.

R3F scene nie ma robic:

- topologicznego indeksowania;
- budowy region overlay maps;
- probkowania duzych vector fields;
- kolorowania duzych field buffers;
- wielkich `setMatrixAt`/`BufferAttribute` loopow bez budzetu klatki;
- synchronizacji wielu konkurencyjnych rewizji.

## 18. Architecture Decisions Locked By This Plan

### Decision 1: One Build Engine, Not Layer-Owned Queues

Kazda warstwa 3D moze miec wlasna semantyke wizualna, ale nie moze miec
wlasnego ukrytego scheduler/cache/worker-policy. W przeciwnym razie nie da sie
odpowiedziec na podstawowe pytanie diagnostyczne: "dlaczego UI zamarzlo przez
3 albo 19 sekund?".

Accepted design:

```text
VectorFieldLayer
ScalarFieldLayer
MeshPartLayer
RegionOverlayLayer
AirboxLayer
  -> request derived handle through build engine
  -> receive current/stale/loading/failed state
  -> render or preserve visible handle
```

Rejected design:

```text
each layer owns its own worker, queue, cache, abort, stale state and logs
```

### Decision 2: Full Quality Is The Product Path

Quality flags remain diagnostic switches, not production fixes. A production
"fast path" that hides objects, reduces glyph density, removes overlays or
lowers mesh fidelity is a regression unless the UI labels it as a deliberate
preview mode and then converges to full quality without user action.

For this work, preview mode is not the chosen solution. The chosen solution is
full-quality buffers built asynchronously and adopted safely.

### Decision 3: Browser Workers First, Server-Derived Later

Browser build engine comes first because it fixes ownership, cancellation,
stale presentation, upload budgeting and diagnostics without requiring backend
API expansion. Server-derived resources are a future scale extension that must
reuse the exact same semantic keys and equivalence tests.

This prevents a split where browser-derived glyphs and server-derived glyphs
have subtly different physical or visual semantics.

### Decision 4: GPU Upload Is A Separate Phase

Moving compute to a Worker is insufficient. Worker output still lands on the
main thread and then enters WebGL. A large buffer can freeze the browser during
adoption/upload even when worker compute is perfect.

Therefore every expensive lane must eventually report:

```text
queueWaitMs
workerComputeMs
transferMs
mainAdoptMs
mainUploadMs
totalWallMs
```

If a freeze remains after workerization, the diagnostic artifact must show
whether the cost is transfer/adopt/upload, not leave us guessing.

### Decision 5: Boot Recorder Is Mandatory, UI Is Supplemental

The diagnostic tool must record from boot without clicks. A Tools/UI surface is
useful for human inspection, but it cannot be the only way to capture startup,
because the failure mode happens before a user can reliably interact with the
browser.

Required behavior:

- recorder starts before workspace modules finish loading when launched by the
  diagnostic recipe;
- viewport build records are captured even if the dialog is never opened;
- UI can show current status and export artifacts, but artifact generation is
  scriptable.

## 19. File-Level Production Contracts

This section turns the architecture into concrete file responsibilities. A file
that violates its responsibility should be split or corrected before the phase
is considered finished.

### 19.1 Build Engine Types

File:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildEngineTypes.ts
```

Responsibilities:

- define build lanes;
- define build request shape;
- define runner context;
- define job snapshot and terminal diagnostic record;
- define visible/stale state vocabulary;
- contain no React imports;
- contain no Three.js imports;
- contain no concrete worker construction.

Must expose stable concepts:

```ts
export type Viewport3DBuildLane =
  | "topology-index"
  | "field-color"
  | "vector-glyph"
  | "region-overlay"
  | "mesh-quality"
  | "binary-decode";

export type Viewport3DVisibleBufferState =
  | "ready-current"
  | "stale-compatible"
  | "stale-physical"
  | "invalid"
  | "building"
  | "failed";
```

The exact exported names may follow the existing implementation, but these
states must exist semantically.

### 19.2 Stable Job Keys

File:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.ts
```

Responsibilities:

- generate deterministic keys from semantic inputs;
- omit camera position from heavy-build keys;
- include algorithm version for invalidation;
- keep browser/server-derived resources compatible;
- provide tests for every lane.

Minimum key test matrix:

| Change | Topology key | Field color key | Vector glyph key | Region overlay key |
|---|---|---|---|---|
| camera orbit | unchanged | unchanged | unchanged | unchanged |
| field revision | unchanged | changed | changed | unchanged unless overlay depends on field |
| topology revision | changed | changed | changed | changed |
| color map/range | unchanged | changed | unchanged unless glyph color uses same range | unchanged |
| vector glyph density | unchanged | unchanged | changed | unchanged |
| region display mode | unchanged | unchanged | unchanged | changed |
| algorithm version | changed for lane | changed for lane | changed for lane | changed for lane |

### 19.3 Scheduler

File:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.ts
```

Responsibilities:

- dedupe identical pending/running jobs;
- apply per-lane concurrency;
- abort obsolete latest-wins groups;
- publish stable external-store snapshots;
- emit terminal diagnostic records;
- reject obsolete jobs before visible mutation;
- dispose cleanly on module unmount.

Required scheduler invariants:

```text
same key + compatible request -> one runner execution
new latest-wins group revision -> old pending/running jobs abort
dispose -> all pending/running jobs abort
abort -> terminal record with abortedAtMs
fallback -> terminal record with fallbackReason
```

### 19.4 Worker Pool

Files:

```text
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPoolTypes.ts
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPool.ts
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPoolDiagnostics.ts
```

Responsibilities:

- create workers lazily;
- cap global worker count;
- cap per-lane worker count;
- terminate idle workers;
- expose active/idle/pending counts;
- treat Worker constructor failure as diagnostic fallback;
- never create unbounded parallel CPU work.

Default production policy:

```ts
export const viewport3DDefaultWorkerPoolPolicy = {
  maxTotalWorkers: 4,
  lanes: {
    "binary-decode": 1,
    "topology-index": 1,
    "field-color": 1,
    "vector-glyph": 2,
    "region-overlay": 1,
    "mesh-quality": 1,
  },
  idleTerminateMs: 30_000,
} as const;
```

If `navigator.hardwareConcurrency` is small, the implementation may lower
limits. It must not raise them automatically above the reviewed policy.

### 19.5 Derived Buffer Cache

Files:

```text
apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dCacheKey.ts
apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.ts
apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dCacheEviction.ts
```

Responsibilities:

- store immutable derived buffers;
- track estimated byte size;
- expose current/stale/invalid state;
- provide explicit retain/release;
- evict by revision and memory pressure;
- never expose mutable buffers to React state;
- dispose entries on viewport unmount.

Cache record shape:

```ts
export interface Viewport3DDerivedBufferCacheEntry<TBuffer> {
  readonly key: string;
  readonly lane: Viewport3DBuildLane;
  readonly state: Viewport3DVisibleBufferState;
  readonly visibleRevision: string | null;
  readonly targetRevision: string | null;
  readonly estimatedBytes: number;
  readonly refCount: number;
  readonly createdAtMs: number;
  readonly lastUsedAtMs: number;
  readonly buffer: TBuffer;
}
```

### 19.6 GPU Upload Manager

Files:

```text
apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadTypes.ts
apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts
apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadDiagnostics.ts
```

Responsibilities:

- accept upload tickets from derived buffers;
- split upload work into frame-budgeted slices;
- abort obsolete upload tickets;
- atomically expose visible handles after upload completion;
- record upload bytes, chunks and frames;
- request R3F invalidate only when visible handle changes.

Target budget:

```ts
export const viewport3DGpuUploadDefaultPolicy = {
  targetFrameBudgetMs: 3,
  maxFrameBudgetMs: 5,
  maxBytesPerSlice: 4 * 1024 * 1024,
  maxItemsPerSlice: 50_000,
} as const;
```

The exact byte/item values can be tuned after measurement, but the existence of
the budget is not optional.

### 19.7 Diagnostics Bridge

Files:

```text
apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildDiagnostics.ts
apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.ts
apps/control-room/scripts/record-diagnostics.mjs
```

Responsibilities:

- convert build-engine terminal records into Diagnostic Recorder records;
- aggregate lane summaries in scriptable artifacts;
- keep bounded memory;
- expose dropped-record counts;
- make boot capture independent from opening a dialog;
- keep UI rendering of diagnostics lightweight.

Diagnostic bridge must not depend on R3F. It can subscribe to build-engine
events and write normalized records into the central diagnostic recorder.

## 20. Timing Attribution Model

The plan's central diagnostic promise is attribution. A log that says "viewport
took 15000 ms" is not enough.

### 20.1 Required Timeline For Each Job

For each build job:

```text
queuedAtMs
startedAtMs
workerFinishedAtMs
transferredAtMs
adoptedAtMs
uploadedAtMs
finishedAtMs
abortedAtMs
```

Derived values:

```text
queueWaitMs = startedAtMs - queuedAtMs
workerComputeMs = workerFinishedAtMs - startedAtMs
transferMs = transferredAtMs - workerFinishedAtMs
mainAdoptMs = adoptedAtMs - transferredAtMs
mainUploadMs = uploadedAtMs - adoptedAtMs
totalWallMs = finishedAtMs - queuedAtMs
```

If a timestamp does not apply because the job was aborted before that phase, the
record must keep it `null` and still emit the terminal state.

### 20.2 Required Timeline For UI Freeze Analysis

The diagnostic artifact must align:

- Long Task API entries;
- Long Animation Frame entries;
- React commit/render diagnostics where available;
- build-engine job records;
- resource request/decode timings;
- R3F dirty frame reasons;
- GPU upload records;
- screenshot/readiness milestones.

The artifact should answer:

```text
Did the browser freeze while a build job was only queued?
Did the freeze overlap worker compute, or did worker compute happen off-main?
Did the freeze overlap transfer/adoption/upload?
Did React render during the freeze?
Did R3F invalidate continuously during idle?
Did network/decode block readiness before build work started?
```

### 20.3 Suspect Classification

`record-diagnostics.mjs` should classify the dominant suspect with one of:

```text
resource-request
binary-decode
worker-queue
worker-compute
worker-transfer
main-adoption
gpu-upload
react-render
r3f-frame-loop
browser-gpu-driver
unknown-insufficient-instrumentation
```

`unknown-insufficient-instrumentation` is acceptable only as a temporary result
that creates the next instrumentation task. It is not an acceptable final answer
after this plan is implemented.

## 21. Tools/UI Contract

The diagnostic mechanism has two surfaces:

1. boot/script artifact capture;
2. interactive Tools UI.

The first is mandatory for startup freezes. The second is for human inspection.

### 21.1 Tools Menu Entry

Expected UI location:

```text
Tools -> Diagnostics -> Viewport 3D Build Engine
```

If the current menu architecture uses a different command grouping, the command
still belongs to the existing diagnostic/tools surface, not to viewport layer UI.

The command opens a dialog or panel showing:

- active build jobs by lane;
- queue depth by lane;
- current worker count;
- recent terminal records;
- visible revision vs target revision;
- stale physical targets;
- estimated derived-cache bytes;
- WebGL resource counts from the existing tracker;
- export artifact action.

### 21.2 UI Performance Rules

The diagnostic UI must obey the same performance rules as the viewport:

- no continuous chart animation;
- no unbounded log list rendering;
- no live polling interval;
- snapshots through `useSyncExternalStore` or equivalent stable external-store
  contract;
- virtualized or capped recent records;
- export action reads the bounded controller state, not raw infinite logs.

### 21.3 Boot Capture Without Clicks

The `just` diagnostic recipe must be able to:

- start backend/session/simulation;
- start frontend dev server if needed;
- launch browser;
- enable recorder before the workspace does heavy work;
- wait for readiness milestones;
- perform pan/orbit interaction;
- export logs and screenshots;
- shut down only the processes it owns.

Opening the Tools UI may be added to a manual debug flow, but it is not required
for the automated artifact.

## 22. Production Runbook

This runbook is the required operating procedure for this performance work.

### 22.1 Before A Performance Change

Run or collect:

```bash
git status --short
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Record:

- artifact path;
- max long task;
- max LOAF;
- max viewport frame window;
- top five build jobs by wall time;
- top five main-thread blocking entries;
- final screenshot layer presence.

### 22.2 During A Change

For each phase:

1. Write the smallest failing test that proves the missing contract.
2. Run the targeted test and confirm it fails for the expected reason.
3. Implement only the contract needed for that phase.
4. Run the targeted test and confirm it passes.
5. Run `pnpm --dir apps/control-room typecheck` if public types changed.
6. Update this plan's checklist.
7. Commit a focused checkpoint when the branch is in a passing state.

Commit subjects should be specific:

```text
feat(control-room): add viewport build scheduler diagnostics
feat(control-room): move vector glyph builds to bounded workers
feat(control-room): add viewport derived buffer cache
feat(control-room): budget viewport gpu uploads
```

### 22.3 After A Change

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
pnpm --dir apps/control-room test
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
git diff --check
```

For any change touching viewport runtime, R3F, WebGL, workers or diagnostics:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Before claiming performance success:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

### 22.4 Artifact Review Checklist

After each full diagnostic, inspect and record:

- final screenshot exists and shows full-quality viewport;
- WebGL context is not lost;
- drawing buffer dimensions are non-zero;
- no active idle render loop after settling;
- queue wait max per lane;
- worker compute max per lane;
- transfer/adopt/upload max per lane;
- React/render long entries during freeze windows;
- visible stale state, if any;
- memory/resource counts before and after unmount.

## 23. Acceptance Matrix

| Area | Green | Yellow | Red |
|---|---|---|---|
| Visual quality | final screenshot shows all required layers | temporary stale state is visible and labeled | layer hidden/reduced to pass timing |
| Startup freeze | no Fullmag-owned long task above 100 ms | isolated 100-250 ms task with clear owner | multi-second unexplained freeze |
| Camera pan/orbit | no build job scheduled by camera-only key | brief frame spike classified as GPU/browser | camera schedules topology/field rebuild |
| Idle behavior | zero viewport frames after settling | one recovery frame with reason | continuous frames without explicit animation |
| Worker pool | bounded by reviewed policy | fallback recorded due environment | unbounded workers or silent fallback |
| Cache | bounded bytes and release tests pass | elevated bytes with explicit pressure log | stale FEM buffers leak across use |
| Upload | frame-budgeted chunks | measured budget exceed with diagnostic | one large unbounded upload mutation |
| Diagnostics | artifact classifies dominant cost | unknown creates next instrumentation task | artifact cannot explain freeze |
| Lifecycle | smoke proves canvas visible and context valid | teardown-only context loss proven | startup context loss or blank canvas |

## 24. Detailed Implementation Task Slices

These slices are intentionally small. Each should be independently reviewable.

### Slice A: Build Diagnostics Bridge

Goal: terminal build records appear in Diagnostic Recorder artifacts.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildDiagnostics.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildDiagnostics.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.test.ts`

Expected tests:

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/viewport-3d/build-engine/viewport3dBuildDiagnostics.test.ts \
  src/modules/viewport-3d/viewport3dDiagnostics.test.ts \
  src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.test.ts
```

Acceptance:

- fallback reason is recorded;
- obsolete abort is recorded;
- records are bridged to the central diagnostic recorder;
- bridge has no R3F dependency.

### Slice B: Visible/Stale Buffer State

Goal: layers can preserve previous full-quality buffers without lying about
which physical revision is visible.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.test.ts`

Required tests:

```text
new field revision while old glyph buffer visible -> stale-physical
style-only rebuild while old buffer compatible -> stale-compatible
topology revision mismatch -> invalid, not displayed
release after layer unmount -> refCount decremented and buffer eligible for eviction
```

Acceptance:

- no old physical field can be presented as current;
- no full-quality buffer is discarded just because a new compatible build starts;
- memory ownership is explicit.

### Slice C: Vector Glyph Lane Completion

Goal: vector glyphs are full quality, bounded, abortable and explainable.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: vector glyph scheduler/layer/render-model tests.

Required tests:

```text
two independent vector jobs use two workers
third vector job waits when two workers are active
obsolete vector result cannot replace current handle
worker unavailable emits fallback diagnostic
camera-only change does not reschedule vector build
```

Acceptance:

- vector lane no longer serializes all independent builds through one worker;
- diagnostics expose queue wait vs worker compute;
- final glyph quality matches baseline settings.

### Slice D: GPU Upload Budget

Goal: worker results do not cause a second main-thread freeze during adoption.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts`
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`

Required tests:

```text
large upload is split into multiple tickets
obsolete ticket aborts before visible mutation
visible handle swaps only after all chunks complete
upload diagnostic records chunk count and max chunk duration
```

Acceptance:

- upload is no longer an unbounded loop inside a React/R3F update;
- visible geometry changes atomically;
- dirty frame happens once after handle adoption.

### Slice E: Field Color Lane

Goal: scalar/vector color mapping does not block camera or React.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts`
- Create: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildWorker.ts`
- Test: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.test.ts`
- Modify: mesh/scalar color consuming layers.

Required tests:

```text
field revision changes color key
camera-only change keeps color key stable
topology revision invalidates color buffer
worker output matches current color-map semantics for fixture input
```

Acceptance:

- color output is semantically identical to current renderer;
- topology is reused on field-only changes;
- color build cost appears as lane timing.

### Slice F: Topology And Region Overlay Lanes

Goal: mesh/region preprocessing is not repeated on field-only updates.

Files:

- Create/modify topology index model and worker files under `apps/control-room/src/modules/viewport-3d/`.
- Create region overlay build model/worker files under `apps/control-room/src/modules/viewport-3d/region-overlays/`.
- Modify region and mesh layers.

Required tests:

```text
field-only update does not rebuild topology index
region display mode changes only region overlay key
airbox full wireframe still includes interior bounds overlay
primitive authored overlay remains while realized mesh overlay builds
```

Acceptance:

- region overlays preserve visual contract;
- field updates cannot trigger topology-heavy rebuilds;
- overlay records include bytes and item counts.

### Slice G: Full Diagnostic Artifact

Goal: the CofeB scenario produces a self-explaining artifact.

Files:

- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Modify: diagnostic recorder types/controller if the artifact schema needs new fields.
- Modify: `justfile` only to stabilize the existing diagnostic command.

Required command:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Acceptance:

- artifact contains `viewport3dBuildSummary`;
- artifact contains screenshot;
- artifact contains layer-presence checks;
- artifact names dominant suspect if a freeze remains;
- no manual browser clicks are required.

## 25. Production Definition Of Done

This work is done only when all statements below are true:

- full frontend gates pass;
- viewport browser smoke passes;
- CofeB diagnostic artifact exists from the current branch;
- artifact shows full-quality final 3D visualization;
- no Fullmag-owned unexplained multi-second freeze remains;
- remaining long tasks, if any, are classified with owner and next action;
- idle viewport frame count settles to zero;
- worker pool is bounded and disposes on unmount/idle;
- derived cache has release tests;
- GPU upload is budgeted or proven not to be the current freeze source;
- Diagnostic Recorder can capture from boot without opening UI;
- Tools UI can inspect current build-engine state without creating load;
- plan checkboxes reflect actual implemented state;
- no diagnostic switch is used as a production quality reduction.

## 26. Second-Pass Self-Review

Po ponownym przeczytaniu pierwszej zapisanej wersji planu dopisalem te elementy,
bo bez nich plan nie bylby wystarczajaco produkcyjny:

1. File-level contracts: zeby implementator nie musial zgadywac, ktory plik jest
   wlascicielem scheduler/cache/upload/diagnostics.
2. Timing attribution model: zeby log nie konczyl sie na "viewport took 15 s",
   tylko rozbil koszt na queue, worker, transfer, adopt, upload i React/R3F.
3. Tools/UI contract: zeby bylo jasne, ze UI istnieje, ale boot capture dziala
   bez klikania.
4. Runbook: zeby kazda zmiana miala baseline, targeted gate, browser smoke i
   realny CofeB artifact.
5. Acceptance matrix: zeby nie zaakceptowac "wydajnosci" uzyskanej przez
   obnizenie jakosci.
6. Detailed slices: zeby kolejne commity byly male, reviewable i mierzalne.
7. Production definition of done: zeby nie oglosic sukcesu po samym typechecku.

Po tej korekcie strategia jest kompletna architektonicznie: laczy background
compute, bounded scheduling, stale-aware cache, frame-budgeted upload, boot-first
diagnostics, UI inspection, memory lifecycle i realny diagnostic gate.

## 27. Confidence Statement

Jestem w 100% pewien kierunku produkcyjnego: freeze trzeba usunac przez
kontrolowany pipeline budowania wizualizacji, a nie przez usuwanie jakosci
renderu. To jest wlasciwy poziom abstrakcji dla Fullmag, bo utrzymuje jeden
viewport, jedna semantyke zasobow, jeden kontrakt diagnostyczny i jeden finalny
standard jakosci.

Nie wolno jednak zamienic tej pewnosci architektonicznej w niezweryfikowana
deklaracje wyniku. Wynik musi potwierdzic aktualny artefakt:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Jesli artefakt nadal pokaze multi-second freeze, to plan nadal jest dobry, ale
nastepny krok wybiera sie z danych: `gpu-upload`, `field-color`,
`topology-index`, `region-overlay`, `react-render` albo brakujaca
instrumentacja.

## 28. Failure And Recovery Model

Ten plan musi miec jawny model awarii, bo produkcyjne narzedzie diagnostyczne
nie moze dzialac tylko dla szczesliwej sciezki.

### 28.1 Worker Failure

When a worker lane fails:

- mark the exact lane job as `failed`;
- preserve the previous visible buffer if its state is `ready-current`,
  `stale-compatible`, or explicitly accepted `stale-physical`;
- release the worker lease;
- record `fallbackReason`, stack/error summary, key, lane and revision ids;
- do not retry in a loop;
- allow a new semantic revision or explicit user retry to schedule a new job.

The UI must not silently hide the failed layer. It should show that the target
visualization is incomplete, while the exported artifact carries the technical
details.

### 28.2 GPU Upload Failure

When GPU upload fails:

- abort the upload ticket;
- prevent partial visible-handle swap;
- release cache references that were acquired for the aborted upload;
- keep the previous visible handle if semantically valid;
- record WebGL context status, upload bytes completed, slice count and failing
  resource type;
- mark the viewport state as `partial-failed` if a required layer could not be
  updated.

### 28.3 WebGL Context Loss

`THREE.WebGLRenderer: Context Lost` during startup remains a failure signal
until the diagnostic artifact proves it is teardown-only. Recovery rules:

- clear render-plane handles;
- keep valid data-plane resource cache entries;
- rebuild GPU resources from current derived-cache handles;
- record context loss and restoration timestamps;
- verify `gl.isContextLost() === false` and drawing buffer dimensions are
  non-zero before treating the viewport as ready.

### 28.4 Memory Pressure

Memory pressure response order:

1. Drop old diagnostic events after incrementing dropped-event counters.
2. Evict unretained stale derived buffers.
3. Terminate idle workers.
4. Reduce cache retention windows.
5. Ask for a fresh diagnostic classification if pressure persists.

Do not hide layers or lower final visual quality as a memory-pressure response
for this work.

## 29. Server-Side Scalability Path

Browser workers are the immediate production fix because they solve ownership,
cancellation, stale presentation, upload pacing and diagnostics in the current
frontend. Very large FEM cases will eventually need server-side derived
visualization resources, but those resources must reuse the same semantic key
contract.

Candidate resources:

```text
GET /v2/sessions/current/visualization/derived/topology-index
GET /v2/sessions/current/visualization/derived/field-colors
GET /v2/sessions/current/visualization/derived/vector-glyphs
GET /v2/sessions/current/visualization/derived/region-overlays
GET /v2/sessions/current/visualization/derived/mesh-quality
```

Required metadata for every server-derived payload:

- lane;
- semantic build key;
- algorithm version;
- source topology revision;
- source field revision where applicable;
- target visualization revision;
- output byte lengths;
- item counts;
- provenance `origin: "server-derived"`.

Browser-derived payloads must expose equivalent metadata with
`origin: "browser-worker"`. Equivalence tests must compare counts, mappings,
colors, transforms, bounds and stale/invalid classification for the same key.

This prevents a future split where server and browser produce visually similar
but semantically different render data.

## 30. Verification Matrix

| Change kind | Unit tests | Static audit | Browser smoke | CofeB diagnostic | Memory stress |
|---|---|---|---|---|---|
| key/store/scheduler | required | optional | optional | optional | optional |
| worker pool | required | optional | optional | recommended | recommended |
| cache/refcount | required | optional | optional | recommended | required |
| R3F layer integration | required | required | required | recommended | required |
| GPU upload manager | required | required | required | required | required |
| field-color lane | required | required | required | required | required |
| topology/overlay lane | required | required | required | required | required |
| diagnostic recorder/script | required | optional | required | required | optional |

Known repo commands for this plan:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
pnpm --dir apps/control-room audit:compute-performance
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
pnpm --dir apps/control-room audit:viewport-3d-profile-switch
pnpm --dir apps/control-room test
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Browser/Playwright commands may need unsandboxed execution in this agent
environment because Chromium sandboxing can fail under restricted process
permissions. If that happens, rerun with explicit escalation and record the
reason.

## 31. Final Production Decision

The selected production solution is:

```text
central viewport 3D build engine
  + semantic revision keys
  + lane-aware bounded worker pool
  + reference-counted derived-buffer cache
  + explicit stale-compatible/stale-physical states
  + frame-budgeted GPU upload manager
  + boot-time diagnostic recorder
  + memory/resource registry
  + Tools UI inspection
  + full CofeB diagnostic proof
```

This is the strongest path because it keeps full visual quality and fixes the
actual ownership problem. It follows the mature simulation-software separation
between physical resources, postprocessed presentation buffers, GPU handles and
interactive UI. It also leaves a clean path for future server-side derived
resources without changing viewport semantics.

No implementation should be accepted as complete until the current branch
produces a CofeB diagnostic artifact with full-quality 3D and no unexplained
Fullmag-owned multi-second browser freeze.
