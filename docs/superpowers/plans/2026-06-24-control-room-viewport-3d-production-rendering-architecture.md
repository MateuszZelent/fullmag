# Control Room Viewport 3D Production Rendering Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zbudowac produkcyjny pipeline wizualizacji 3D dla Control Room, ktory zachowuje pelna jakosc obrazu, nie mrozi glownego watku przegladarki podczas ladowania i aktualizacji, oraz zostawia kompletny artefakt diagnostyczny pozwalajacy wskazac kazdy kosztowny etap.

**Architecture:** Control Room ma dzialac jak profesjonalny system postprocessingu symulacji: resource-first input, domain-neutral render model, centralny build engine, bounded worker lanes, derived-buffer cache, frame-budgeted GPU upload, dirty-driven R3F presentation, stale-state honesty, memory ownership i forensic diagnostics od bootu. Main thread odpowiada za interakcje, male snapshoty React, adopcje WebGL i submit draw calls; ciezkie indeksy, dekody, mapowania kolorow, glyph transforms i overlay maps ida do workerow albo w kolejnym etapie do server-derived resources.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Playwright/Chromium CDP, Three.js/R3F, Web Workers, Transferable typed arrays, Fullmag v2 resource-first API facade, Diagnostic Recorder, MemoryBudgetRegistry, existing viewport dirty-frame diagnostics.

---

## 0. Reader Guide And Plan Status

This is the production master plan for Fullmag Control Room 3D visualization
performance. It is intentionally wider than a normal implementation checklist
because the current freeze problem crosses resource fetching, binary decoding,
derived visualization buffers, worker scheduling, WebGL upload, R3F layer
ownership, interaction priority, diagnostics and memory lifecycle.

This file should be used as the architectural source of truth for the whole
viewport performance program. It should not be implemented as one huge patch.
Implementation continues through smaller tracked slices, starting with:

```text
docs/superpowers/plans/2026-06-24-control-room-viewport-3d-build-engine.md
```

Use this document to answer:

- what the final production architecture must look like;
- what quality must never be sacrificed for speed;
- which subsystem owns each expensive phase;
- which diagnostic artifact proves a phase improved;
- which next implementation slice is allowed;
- which shortcuts are rejected even if they make a benchmark look better.

Use the build-engine tracker to answer:

- which checkbox is currently being implemented;
- which tests must be written first;
- which files are in the current slice;
- which verification commands have passed.

The plan has gone through multiple self-review passes in this file. The final
professional decision is stable:

```text
preserve full visual quality
separate compute, transfer, adoption and GPU upload
bound every worker and cache
make stale data explicit
record diagnostics from boot
choose the next optimization from artifacts
```

## 1. Executive Decision

Nie naprawiamy problemu przez obnizanie jakosci wizualizacji.

Zakazane jako produkcyjna optymalizacja:

- wylaczanie mesh surfaces;
- wylaczanie vector glyphs;
- ukrywanie region overlays;
- uproszczenie airbox wireframe;
- stale zmniejszenie gestosci glyphow;
- stale przejscie na podglad niskiej jakosci;
- ciagle renderowanie w `requestAnimationFrame`, zeby zamaskowac opuznienia;
- przeniesienie duzych buforow do React state albo Zustand;
- rozbicie FDM/FEM na osobne viewporty.

Poprawny kierunek:

```text
v2 resource hooks
  -> typed binary/JSON resources
  -> domain adapters
  -> semantic render model
  -> viewport 3D build engine
  -> bounded worker lanes
  -> derived-buffer cache
  -> frame-budgeted GPU upload
  -> atomic visible handle adoption
  -> one demand-rendered R3F canvas
  -> diagnostic recorder artifact
```

Profesjonalny system typu COMSOL lub duzy postprocessor CAE nie zaklada, ze wszystko musi powstac synchronicznie w UI. Zwykle rozdziela:

- model fizyczny i solver results;
- derived visualization buffers;
- worker/server postprocessing;
- GPU upload/presentation;
- viewport interaction loop;
- diagnostic/profiling plane.

To samo robimy w Fullmag. Wizualizacja pozostaje bogata, ale koszt jej przygotowania jest kontrolowany, przerywalny, mierzony i odseparowany od interakcji.

## 2. Success Criteria

Plan jest wykonany dopiero wtedy, gdy realny scenariusz CofeB rings potwierdzi wszystkie warunki.

Functional criteria:

- finalny viewport pokazuje pelna jakosc: mesh, field colors, vector glyphs, region overlays, airbox, bounds, HUD, selection and dimension frame;
- camera orbit, pan i zoom pozostaja responsywne podczas ladowania i aktualizacji danych;
- field-only update nie przebudowuje topologii;
- topology update uniewaznia tylko topologicznie zalezne buffery;
- non-3D center tabs unmount viewport 3D and release heavy resources;
- Diagnostic Recorder startuje od bootu bez klikania w UI;
- artefakt diagnostyczny wskazuje dominujacy koszt freeze'u bez recznego przegladania konsoli.

Performance criteria:

- no Fullmag-owned main-thread task above `100 ms` during idle and normal update path;
- no multi-second long animation frame caused by Fullmag-owned work;
- no repeated long tasks after viewport settles;
- idle viewport frames settle to zero;
- GPU upload slices stay within configured frame budget;
- worker count is bounded and visible in diagnostics;
- queue wait, worker compute, transfer, main adoption and GPU upload are separated in reports.

Memory criteria:

- no unbounded cache growth across quantity switches;
- no stale worker after viewport unmount;
- no WebGL geometry/material/texture leak after 3D -> 2D -> 3D switching;
- no large typed arrays stored in React state;
- every cache handle has ref-counted release;
- every object URL and listener has cleanup.

Evidence criteria:

- targeted unit tests pass;
- full frontend test/lint/typecheck gates pass;
- browser smoke proves canvas visible, WebGL context not lost and drawing buffer non-zero;
- CofeB diagnostic artifact contains before/after comparable timings;
- final screenshot proves full-quality layers are present.

## 3. Current Evidence And Problem Shape

Observed from prior diagnostics:

- problematic FEM visualization case has about `59620` nodes, `342415` tetrahedra and `92144` boundary faces;
- final screenshot can show full-quality visualization, so this is not a missing rendering feature;
- measured freeze included multi-second main-thread/animation-frame stalls;
- dirty reasons pointed at `vector-glyph-material`, `field-colors`, `region-mesh-overlay`;
- vector glyph work has partial worker support, but main thread still pays transfer/adoption/upload and some lanes remain ad hoc;
- topology decode/indexing, field color mapping, overlay derivation and GPU upload are not yet managed as one production pipeline;
- diagnostics need stronger separation of queue time, worker time, transfer time, main adoption time and GPU upload time.

Interpretation:

The browser freezes because expensive visualization phases are not owned by a central pipeline. Some costs are already moved, but the system still has ad hoc per-layer build paths, incomplete cancellation, incomplete stale presentation, incomplete GPU upload budgeting and incomplete attribution.

The fix is not one optimization. The fix is a production visualization execution model.

## 4. Non-Negotiable Product Contract

1. Full-quality visualization remains the default final output.
2. Temporary diagnostic flags may isolate a layer, but cannot be the production solution.
3. One viewport module renders FDM and FEM through a domain-neutral render model.
4. One R3F `<Canvas frameloop="demand">` remains the presentation surface.
5. Heavy binary payloads are resources, not component state.
6. Derived visualization buffers are keyed by semantic revisions.
7. Camera-only interaction cannot schedule topology, field-color, vector-glyph or overlay rebuilds.
8. Field revision changes cannot rebuild topology unless topology revision also changed.
9. Previous visible buffers may stay on screen during rebuild only with explicit stale state.
10. Stale physical data must be visible in diagnostics and UI state.
11. Obsolete worker results must be abortable before adoption and upload.
12. GPU upload is a scheduled phase, not an unbounded side effect in a layer.
13. Every worker, WebGL resource, typed array cache entry and listener has an owner and release trigger.
14. Diagnostic recording must be bounded and cannot create its own performance problem.
15. No performance claim is accepted without artifact evidence.

## 5. Relationship To Existing Plans

This document is the production architecture plan. It does not replace the existing implementation tracker:

```text
docs/superpowers/plans/2026-06-24-control-room-viewport-3d-build-engine.md
```

That existing plan is the first execution slice. It already contains work around:

- build-engine key types;
- scheduler/store;
- bounded vector worker pool;
- derived-buffer cache;
- build diagnostics;
- GPU upload manager foundation.

This new plan widens the scope to the full professional rendering system:

- all expensive 3D lanes;
- full diagnostic artifact;
- interaction responsiveness;
- memory/resource lifecycle;
- UI tooling;
- future server-side derived visualization resources;
- CI/performance governance.

### 5.1 Plan Classification

This is a master production plan, not a single small implementation slice. It
must be executed through smaller, testable implementation plans and checkpointed
branches. The current build-engine tracker is the first execution slice.

Execution rule:

- every phase must leave `apps/control-room` shippable;
- every phase must have tests before production integration;
- every performance claim must have a diagnostic artifact;
- every branch must preserve full-quality final visualization;
- every optimization that changes visible output requires explicit user review.

This plan is allowed to be broad because the problem is architectural. It is
not allowed to be vague: each phase below states owners, files, evidence and
acceptance gates.

### 5.2 Professional Reference Model

Large simulation tools do not treat the viewport as a React component that
computes everything during render. They treat visualization as a production
pipeline with separate stages:

| Concern | Professional pattern | Fullmag target |
|---|---|---|
| Physical truth | solver/model resources are canonical | v2 resource-first API and ProblemIR provenance |
| Derived visualization | separate derived buffers and postprocessing | viewport build engine and future server-derived resources |
| UI responsiveness | main thread stays interactive | workers plus frame-budgeted GPU upload |
| Presentation | stale/current state is explicit | visible/target revision and stale state |
| Diagnostics | timelines identify the expensive stage | Diagnostic Recorder artifact and suspect report |
| Memory | resources have ownership and release | resource tracker, cache refs and memory stress gates |
| Scale | heavy postprocess can move server-side | same build-key contract for browser/server derived buffers |

The key lesson is not "use more workers". The lesson is ownership. Every
expensive result needs a key, queue, owner, cache state, upload phase, visible
adoption rule, diagnostic record and release trigger.

### 5.3 Alternatives Considered

#### Alternative A: Disable Or Simplify Layers

Rejected as a production solution.

It can prove that a layer contributes to freeze time, but it breaks the product
contract. The goal is not a faster poorer viewer. The goal is full scientific
visualization with controlled execution.

#### Alternative B: Only Memoize Existing React/R3F Code

Rejected as insufficient.

Memoization can reduce repeated work, but it cannot make a single huge
topology/color/glyph/upload operation non-blocking. It also risks hiding wrong
state ownership behind object identity tricks.

#### Alternative C: Move All Derived Work To Backend Immediately

Rejected as the first step.

Backend-derived visualization buffers are a valid future direction for very
large cases, but doing it first would expand API/backend scope before the
browser pipeline has a precise key/cache/diagnostic contract. First the browser
pipeline must define semantics. Then backend derived resources can implement
the same contract.

#### Alternative D: One Central Build Engine With Worker Lanes And Upload Manager

Accepted.

This solves the actual failure class while preserving quality. It also creates
the exact boundary required for future server-derived resources without forking
visual semantics.

### 5.4 Maturity Levels

This plan should be judged by maturity, not by one merged patch.

| Level | Name | Meaning |
|---|---|---|
| L0 | Observable | recorder captures boot, long tasks, viewport frames and screenshots |
| L1 | Attributed | every freeze is assigned to fetch, decode, worker, transfer, adoption, upload, React or browser |
| L2 | Bounded | workers, queues, cache and upload slices have hard limits |
| L3 | Responsive | camera and UI remain responsive during normal full-quality updates |
| L4 | Leak-safe | memory/resource stress shows bounded growth across repeated workflows |
| L5 | Scalable | browser and server-derived buffer paths share keys and equivalence tests |

Current work is between L1 and L2. The first production target is L3 for the
CofeB rings case, followed immediately by L4.

## 6. Architecture Overview

### 6.1 Control Plane

The control plane owns user intent and canonical state:

- current session;
- active center surface;
- selected quantity;
- visualization profile;
- layer visibility;
- per-object display settings;
- camera state;
- selection;
- diagnostics profile.

Control plane data is JSON/resource metadata. It should be small and revision-driven.

### 6.2 Data Plane

The data plane owns heavy numerical payloads:

- topology coordinates;
- connectivity;
- field vectors/scalars;
- mesh part maps;
- region/airbox metadata;
- artifacts;
- future derived visualization buffers.

Data plane resources are fetched through typed API/resource hooks. Components must not hand-roll `/v2/...` fetch calls.

### 6.3 Render Model Plane

The render model converts control plane and data plane resources into semantic viewport inputs:

- `topologyRevision`;
- `fieldRevision`;
- `targetVisualizationRevision`;
- `quantityId`;
- `component`;
- `scopeKind`;
- `scopeId`;
- layer profile;
- sampling profile;
- per-target visualization state;
- display units and transform hints.

It may compute small metadata. It must not allocate or transform large render buffers.

### 6.4 Build Engine Plane

The build engine owns expensive derived work:

- stable build keys;
- request dedupe;
- latest-wins cancellation;
- per-lane queueing;
- bounded worker pool;
- fallback diagnostics;
- derived-buffer cache;
- stale-state decisions;
- GPU upload tickets;
- diagnostic records.

The build engine is the boundary between "we know what should be shown" and "we have built/uploaded the buffers needed to show it".

### 6.5 Presentation Plane

The R3F layer tree consumes handles:

- geometry handles;
- color buffer handles;
- glyph buffer handles;
- overlay handles;
- material/uniform updates;
- small status snapshots.

It does not perform unbounded derivation during render. It invalidates demand rendering only when visible handles or small visual state change.

### 6.6 Diagnostic Plane

Diagnostics start before React and continue through:

- boot;
- resource fetch;
- binary decode;
- render-model creation;
- build-engine jobs;
- worker pool activity;
- transfer/adoption;
- GPU upload;
- R3F frames;
- WebGL resource tracking;
- memory snapshots;
- console/page errors;
- browser long tasks and long animation frames.

The final artifact must tell which phase caused a freeze.

## 7. Thread And Process Ownership

### Main Thread

Allowed:

- React render of small state;
- command/menu interactions;
- camera event handling;
- resource hook orchestration;
- worker scheduling;
- small material/uniform changes;
- WebGL object creation/adoption;
- scheduled GPU upload slices;
- dirty-frame invalidation.

Not allowed:

- building large topology indices;
- mapping full field colors synchronously;
- composing large vector glyph matrices in one frame;
- deriving region overlay maps for large meshes;
- decoding large binary buffers synchronously when worker path exists;
- processing full diagnostic logs in render;
- holding large typed arrays in React state.

### Worker Threads

Allowed:

- binary decode when practical;
- topology indices;
- field-color buffers;
- vector glyph samples/transforms/colors;
- region overlay maps;
- mesh-quality scalar arrays;
- statistics/range calculation when backend stats are absent.

Required:

- bounded concurrency;
- abort handling;
- transferables where safe;
- queue/compute/transfer diagnostics;
- idle termination;
- fallback record if Worker is unavailable.

### Browser GPU/WebGL

Allowed:

- final buffer upload;
- draw calls;
- shader/material work;
- render targets where needed.

Required:

- upload tickets;
- per-frame byte/item budgets;
- atomic visible adoption;
- cleanup on unmount/context loss;
- context loss diagnostics.

### Backend / Future Server-Derived Resources

Allowed later:

- derived topology index resource;
- derived field color resource;
- derived vector glyph resource;
- derived overlay resource.

Required later:

- same build-key contract as browser workers;
- binary data plane;
- provenance `origin: "browser-worker" | "server-derived"`;
- equivalence tests;
- browser fallback.

## 8. Production Pipeline Flows

### 8.1 Cold Workspace Boot

```text
instrumentation-client
  -> early diagnostic recorder
  -> kernel bootstrap
  -> resource hooks subscribe
  -> status/revision resources resolve
  -> viewport module mounts
  -> render model snapshot created
  -> build engine schedules lanes
  -> workers build derived buffers
  -> cache stores immutable results
  -> GPU upload manager uploads slices
  -> visible handles adopt atomically
  -> demand render
  -> idle audit window
```

Acceptance:

- recorder captures everything from page navigation;
- boot freeze is attributed;
- first visible viewport may progressively become ready, but final state is full quality;
- no layer silently disappears to meet budget.

### 8.2 Field Revision Update

```text
fieldRevision changes
  -> field-color key changes
  -> vector-glyph key changes
  -> topology-index key unchanged
  -> region-overlay key unchanged unless target/region semantics changed
  -> previous visible field buffers marked stale-physical
  -> new field buffers build in workers
  -> upload manager schedules replacement
  -> visible revision becomes current
```

Acceptance:

- topology geometry is not rebuilt;
- camera remains responsive;
- stale physical state is explicit until replacement completes.

### 8.3 Topology Revision Update

```text
topologyRevision changes
  -> topology-index invalidates
  -> field-color/vector-glyph/overlay keys invalidate where topology-dependent
  -> incompatible visible handles become invalid
  -> compatible primitive/fallback overlays may remain if semantically safe
  -> new topology lanes build
  -> dependent lanes build after required topology handles exist
  -> upload/adoption happens per lane budget
```

Acceptance:

- invalid topology is never displayed as current;
- dependent lanes do not race into inconsistent visible state;
- diagnostics show dependency wait separately from worker compute.

### 8.4 Camera Interaction

```text
pointer/camera input
  -> camera transient state
  -> demand invalidate
  -> no heavy build key changes
  -> no worker lane scheduled
  -> no resource refetch
```

Acceptance:

- pan is as responsive as orbit within expected pointer-control cost;
- build-engine job count remains unchanged during pure camera motion.

### 8.5 Quantity/Style Update

```text
quantity/style change
  -> semantic keys update only for affected lanes
  -> topology remains cached
  -> material/uniform-only updates avoid geometry rebuild
  -> field color/glyph lanes rebuild only where required
  -> stale-compatible or stale-physical state recorded
```

Acceptance:

- no unnecessary topology work;
- no broad React rerender proportional to mesh size;
- final color/glyph semantics match current implementation.

### 8.6 Viewport Unmount

```text
active center tab changes away from viewport-3d
  -> abort pending jobs
  -> release cache handles
  -> abort upload tickets
  -> dispose geometries/materials/textures/render targets
  -> remove listeners/observers
  -> terminate idle workers
  -> record resource baseline
```

Acceptance:

- no mounted R3F canvas on non-3D tabs;
- no active 3D resource hooks;
- WebGL resource counts return to baseline.

## 9. Build Lanes

### 9.1 Binary Decode Lane

Purpose:

- decode large binary resources without blocking UI;
- measure network, decode, transfer and adoption separately.

Inputs:

- resource key;
- content type;
- byte length;
- revision;
- abort signal.

Outputs:

- typed arrays;
- decode diagnostics;
- ownership metadata.

Acceptance:

- aborting a stale resource prevents state update after unmount;
- decode fallback is recorded when worker path is unavailable.

### 9.2 Topology Index Lane

Purpose:

- build face/element/object/part adjacency and lookup structures.

Key inputs:

- topology revision;
- mesh manifest revision;
- target registry revision;
- algorithm version.

Outputs:

- immutable topology index handle;
- estimated byte count;
- object/part mapping diagnostics.

Acceptance:

- field revision does not affect key;
- camera and selection do not affect key;
- cache hit is visible in diagnostics.

### 9.3 Field Color Lane

Purpose:

- map scalar/vector values to color buffers at full quality.

Key inputs:

- topology revision;
- field revision;
- quantity id;
- component;
- color map;
- color range;
- target/scope;
- algorithm version.

Outputs:

- typed color buffer;
- range/stat diagnostics;
- stale-compatible/stale-physical classification.

Acceptance:

- color output matches existing visual semantics;
- topology geometry is reused;
- GPU upload is ticketed, not synchronous.

### 9.4 Vector Glyph Lane

Purpose:

- build full-quality vector glyph transforms, colors and visibility.

Key inputs:

- topology revision;
- field revision;
- vector quantity/component;
- scope;
- sampling profile;
- glyph geometry version;
- target visualization revision;
- scale/style revisions.

Outputs:

- glyph count;
- transform buffer;
- color buffer;
- bounds;
- diagnostics for queue/compute/output bytes.

Acceptance:

- no single serialized worker bottleneck for independent glyph jobs;
- no obsolete glyph result can replace visible current data;
- full glyph quality is preserved.

### 9.5 Region Overlay Lane

Purpose:

- derive region/part overlay geometry and mapping without blocking UI.

Key inputs:

- topology revision;
- region revision;
- overlay mode;
- target visualization revision;
- algorithm version.

Outputs:

- overlay geometry/index/color buffers;
- part/group summary;
- degraded/fallback reason if backend mapping is incomplete.

Acceptance:

- region overlay can update independently from field color;
- authored primitive overlay can remain while realized overlay builds when semantically valid.

### 9.6 Mesh Quality Lane

Purpose:

- derive mesh quality scalar buffers and visual maps.

Key inputs:

- topology revision;
- quality metric;
- color map/range;
- target/scope.

Outputs:

- quality scalar/color buffers;
- min/max/stat summary.

Acceptance:

- quality view does not rebuild unrelated field resources;
- quality stats are cached by topology/metric.

### 9.7 Selection/Picking Lane

Purpose:

- keep interaction responsive for hover/selection without deriving full maps on every pointer event.

Key inputs:

- topology index handle;
- object/part mapping;
- current visible geometry handles.

Outputs:

- picking metadata;
- selected identity;
- face/index details where reliable.

Acceptance:

- pointer move does not allocate large buffers;
- unreliable mapping is reported as degraded instead of inventing semantics.

### 9.8 Airbox And Bounds Lane

Purpose:

- preserve airbox wireframe/full volume contract without tying it to heavy magnetic mesh work.

Key inputs:

- airbox manifest;
- geometry scope;
- visualization target state;
- display profile.

Outputs:

- airbox surface handle;
- full bounds/volume wireframe handle;
- visibility/opacity state.

Acceptance:

- full airbox mode always includes volume/bounds overlay;
- airbox wireframe opacity is not attenuated by surface opacity.

## 10. Stable Build Key Contract

Every expensive derived buffer uses semantic keys, not object identity.

Base key:

```ts
export interface Viewport3DProductionBuildKey {
  readonly lane: Viewport3DProductionBuildLane;
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

- camera changes never alter heavy-build keys;
- selection changes alter only selection/picking presentation, not field/topology build keys;
- field revision changes field-color/vector-glyph keys;
- topology revision changes topology-dependent keys;
- style revisions alter only lanes whose output depends on style;
- algorithm version changes invalidate corresponding cache entries;
- browser-worker and future server-derived resources use equivalent keys.

## 11. Scheduler Policy

Global policy:

```ts
export interface Viewport3DProductionSchedulerPolicy {
  readonly maxTotalWorkers: number;
  readonly maxQueuedJobs: number;
  readonly lanes: Record<
    Viewport3DProductionBuildLane,
    {
      readonly maxWorkers: number;
      readonly maxQueuedJobs: number;
      readonly strategy: "fifo" | "latest-wins" | "dependency-gated";
    }
  >;
}
```

Initial conservative policy:

```ts
export const VIEWPORT_3D_PRODUCTION_SCHEDULER_POLICY = {
  maxTotalWorkers: 4,
  maxQueuedJobs: 32,
  lanes: {
    "binary-decode": { maxWorkers: 1, maxQueuedJobs: 4, strategy: "latest-wins" },
    "topology-index": { maxWorkers: 1, maxQueuedJobs: 4, strategy: "latest-wins" },
    "field-color": { maxWorkers: 1, maxQueuedJobs: 6, strategy: "latest-wins" },
    "vector-glyph": { maxWorkers: 2, maxQueuedJobs: 8, strategy: "latest-wins" },
    "region-overlay": { maxWorkers: 1, maxQueuedJobs: 4, strategy: "latest-wins" },
    "mesh-quality": { maxWorkers: 1, maxQueuedJobs: 4, strategy: "latest-wins" },
    "selection-picking": { maxWorkers: 1, maxQueuedJobs: 2, strategy: "fifo" },
  },
} as const;
```

Scheduler rules:

- hardware concurrency can lower limits on weak machines, not raise them above tested defaults;
- obsolete revisions are aborted before adoption/upload;
- dependent lanes wait on required handles explicitly;
- queue wait is measured separately from worker compute;
- fallback to main thread is a diagnostic degradation and must be bounded/chunked;
- dispose aborts pending and running work.

## 12. Derived Buffer Cache

Cache states:

- `ready-current`: matches current target revision;
- `stale-compatible`: previous buffer is visually compatible while new non-physical style output builds;
- `stale-physical`: previous physical field/topology revision is visible while new physical data builds;
- `invalid`: must not be displayed;
- `released`: handle has been released and cannot be adopted again.

Cache rules:

- entries are immutable after ready;
- large arrays are outside React state;
- layers hold retain handles, not raw global ownership;
- memory estimate is recorded for every entry;
- eviction prefers released/stale entries;
- memory pressure can abort queued low-priority builds;
- unmount releases all viewport-owned refs;
- stale-physical state must be surfaced in diagnostics and compact UI status.

## 13. GPU Upload Manager

Problem:

Moving build work to workers is insufficient if the result is uploaded to WebGL in one huge main-thread burst.

Required pipeline:

```text
worker result
  -> derived cache entry
  -> upload ticket
  -> chunked upload slices
  -> onVisible callback
  -> visible handle adoption
  -> demand render invalidation
```

Upload ticket:

```ts
export interface Viewport3DGpuUploadTicket {
  readonly id: string;
  readonly key: string;
  readonly lane: Viewport3DProductionBuildLane;
  readonly estimatedBytes: number;
  readonly abort: () => void;
  readonly done: Promise<Viewport3DGpuUploadResult>;
}
```

Policy:

```ts
export interface Viewport3DGpuUploadPolicy {
  readonly targetFrameBudgetMs: number;
  readonly maxFrameBudgetMs: number;
  readonly maxBytesPerSlice: number;
  readonly maxItemsPerSlice: number;
}
```

Initial policy:

- target frame budget: `3 ms`;
- max frame budget: `5 ms`;
- abort obsolete before visible mutation;
- record chunks, frames, bytes and budget misses;
- atomic adoption only after upload completion.

Acceptance:

- vector glyph matrix/color upload is ticketed;
- field color upload is ticketed;
- overlay/topology uploads are ticketed where applicable;
- no layer performs an unbounded `setMatrixAt`, `needsUpdate` or `BufferAttribute` replacement loop for large data in one frame.

## 14. Diagnostic Artifact Contract

Directory artifact:

```text
.fullmag/reports/control-room-viewport-3d/<timestamp>-<scenario>/
  manifest.json
  summary.json
  suspect-report.md
  timeline.ndjson
  performance.ndjson
  requests.ndjson
  resources.ndjson
  memory.ndjson
  viewport-3d.ndjson
  viewport-3d-build.ndjson
  viewport-3d-upload.ndjson
  workers.ndjson
  console.ndjson
  browser-metrics.ndjson
  chromium-trace.json
  screenshots/
    000-boot.png
    010-first-workspace.png
    020-first-3d-ready.png
    030-after-camera-pan.png
    040-after-field-update.png
    050-idle.png
```

Summary sections:

```text
bootSummary
resourceSummary
binaryDecodeSummary
viewport3dBuildSummary
viewport3dUploadSummary
viewport3dVisibleRevisionSummary
viewport3dResourceOwnershipSummary
interactionSummary
idleSummary
memorySummary
suspectSummary
```

Every build record contains:

```ts
export interface Viewport3DProductionDiagnosticRecord {
  readonly kind: "viewport-3d-build-job" | "viewport-3d-upload-job";
  readonly lane: Viewport3DProductionBuildLane;
  readonly key: string;
  readonly groupKey: string;
  readonly state:
    | "queued"
    | "running"
    | "transferring"
    | "adopting"
    | "uploading"
    | "ready"
    | "failed"
    | "aborted";
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
  readonly staleState: "none" | "stale-compatible" | "stale-physical" | "invalid-suppressed";
}
```

Suspect report must answer:

- was freeze caused by network/resource fetch;
- binary decode;
- worker queue wait;
- worker compute;
- transfer;
- main adoption;
- GPU upload;
- React rerender;
- R3F frame;
- browser/GPU driver/context issue;
- diagnostics overhead.

## 15. Tools UI Surface

The mechanism must work without UI clicks, but it should have a professional UI in Tools.

Required UI surfaces:

- Tools -> Diagnostic Recorder;
- footer recording indicator;
- compact viewport 3D health summary;
- lane status table;
- worker pool status;
- cache bytes and entry counts;
- visible vs target revision state;
- stale-physical warning;
- export artifact button;
- copy suspect report button.

UI constraints:

- no live chart that samples continuously by default;
- no unbounded logs in React state;
- tables render compact summaries and allow explicit export;
- diagnostics profile and capture window are visible;
- UI must not become the performance bottleneck.

## 16. File Responsibility Map

Existing implementation tracker:

```text
docs/superpowers/plans/2026-06-24-control-room-viewport-3d-build-engine.md
```

Production architecture plan:

```text
docs/superpowers/plans/2026-06-24-control-room-viewport-3d-production-rendering-architecture.md
```

Core build engine:

```text
apps/control-room/src/modules/viewport-3d/build-engine/
  viewport3dBuildEngineTypes.ts
  viewport3dBuildJobKeys.ts
  viewport3dBuildScheduler.ts
  viewport3dBuildEngineStore.ts
  viewport3dBuildDiagnostics.ts
```

Worker pool:

```text
apps/control-room/src/modules/viewport-3d/build-engine/workerPool/
  viewport3dWorkerPoolTypes.ts
  viewport3dWorkerPool.ts
  viewport3dWorkerPoolDiagnostics.ts
```

Cache:

```text
apps/control-room/src/modules/viewport-3d/build-engine/cache/
  viewport3dCacheKey.ts
  viewport3dCacheEviction.ts
  viewport3dDerivedBufferCache.ts
```

GPU upload:

```text
apps/control-room/src/modules/viewport-3d/build-engine/gpu/
  viewport3dGpuUploadTypes.ts
  viewport3dGpuUploadManager.ts
  viewport3dGpuUploadDiagnostics.ts
```

Production lane modules to add as lanes mature:

```text
apps/control-room/src/modules/viewport-3d/field-colors/
  viewport3dFieldColorBuildModel.ts
  viewport3dFieldColorBuildWorker.ts
  viewport3dFieldColorBuildScheduler.ts

apps/control-room/src/modules/viewport-3d/region-overlays/
  viewport3dRegionOverlayBuildModel.ts
  viewport3dRegionOverlayBuildWorker.ts
  viewport3dRegionOverlayBuildScheduler.ts

apps/control-room/src/modules/viewport-3d/mesh-quality/
  viewport3dMeshQualityBuildModel.ts
  viewport3dMeshQualityBuildWorker.ts
```

Layers to convert into handle consumers:

```text
apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx
apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx
apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx
apps/control-room/src/modules/viewport-3d/layers/RegionMeshOverlayLayer.tsx
apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx
apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx
```

Diagnostics and scripts:

```text
apps/control-room/src/kernel/performance/diagnostic-recorder/
apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts
apps/control-room/scripts/record-diagnostics.mjs
apps/control-room/scripts/smoke-viewport-3d.mjs
apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs
```

### 16.1 Ownership Matrix

| Unit | Owns | Must not own |
|---|---|---|
| `useViewport3DSceneModel.ts` | semantic revisions, resource query decisions, small render-model metadata | large derived arrays, WebGL resources, worker lifetimes |
| `viewport3dRenderModel.ts` | domain-neutral render model construction | API fetches, worker scheduling, direct R3F mutation |
| `build-engine/*` | keys, scheduler, store snapshots, diagnostics, cache integration | React component layout, visual styling, API endpoint strings |
| `build-engine/workerPool/*` | bounded workers, aborts, queue policy, fallback records | viewport UI state, WebGL adoption |
| `build-engine/cache/*` | immutable derived buffers, ref counts, byte estimates, eviction | canonical resource cache ownership |
| `build-engine/gpu/*` | upload tickets, chunks, budget diagnostics, abort before visible mutation | worker compute, React state |
| `layers/*` | Three.js object/material ownership, small uniforms, visible handle adoption | expensive model derivation, direct API fetches, unbounded loops |
| `Diagnostic Recorder` | bounded timeline records, summaries, export artifacts | continuous high-frequency UI sampling |
| `MemoryBudgetRegistry` | resource budget records and pressure signals | hidden retention of actual buffers |

### 16.2 Boundaries That Must Stay Intact

These boundaries prevent the same class of bug from returning:

- R3F layers consume handles; they do not build heavy buffers.
- Build lanes produce buffers; they do not decide product semantics.
- Resource hooks fetch canonical resources; they do not run postprocessing loops.
- Diagnostics record evidence; they do not become a second live renderer.
- Feature flags isolate diagnostics; they do not define the production product.

## 17. Implementation Roadmap

### Phase 0: Baseline Freeze Artifact

Goal: preserve a comparable baseline before more changes.

Files:

- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Modify: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticSuspectReport.ts`
- Test: `apps/control-room/src/kernel/performance/diagnosticRecorderScript.test.ts`

Steps:

- [ ] Add scenario id `cofeb-rings-relax-full-3d-cold`.
- [ ] Capture startup, first 3D ready, camera pan, camera orbit, field update and idle window.
- [ ] Record max long task, max long animation frame, max viewport frame window and top dirty reasons.
- [ ] Save screenshots for boot, first 3D ready and idle.
- [ ] Add test proving the script writes `suspect-report.md`.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/performance/diagnosticRecorderScript.test.ts
```

Acceptance:

- baseline artifact can be compared against future artifacts;
- no change can claim performance success without this comparison.

### Phase 1: Diagnostic Attribution Hardening

Goal: make logs explain where time goes.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildDiagnostics.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts`
- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildDiagnostics.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.test.ts`

Steps:

- [ ] Add explicit fields for queue, worker, transfer, adoption and upload timings.
- [ ] Add stale-state fields to build records.
- [ ] Add worker fallback reason.
- [ ] Add upload budget exceeded flag.
- [ ] Add summary grouping by lane.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/build-engine src/modules/viewport-3d/viewport3dDiagnostics.test.ts
```

Acceptance:

- artifact can distinguish worker wall time from main-thread blocking time.

### Phase 2: Scheduler And Worker Pool Completion

Goal: make every expensive lane bounded, abortable and observable.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPool.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPool.test.ts`

Steps:

- [ ] Verify latest-wins cancellation for each planned lane.
- [ ] Add queue capacity tests.
- [ ] Add dispose abort tests.
- [ ] Add fallback diagnostic tests.
- [ ] Add idle termination tests.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/build-engine/viewport3dBuildScheduler.test.ts src/modules/viewport-3d/build-engine/workerPool/viewport3dWorkerPool.test.ts
```

Acceptance:

- no lane can create unbounded workers or unbounded pending jobs.

### Phase 3: Vector Glyph Production Lane

Goal: remove vector glyph as a startup/update freeze source while preserving full glyph quality.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildWorker.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.test.ts`

Steps:

- [ ] Route all vector builds through build-engine keys.
- [ ] Keep pure glyph model worker-safe.
- [ ] Use bounded worker pool for independent vector jobs.
- [ ] Retain last good glyph buffers during rebuild.
- [ ] Mark previous field glyphs as stale-physical when field revision advances.
- [ ] Route glyph matrix/color upload through GPU upload manager.
- [ ] Abort obsolete upload before visible mutation.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.test.ts src/modules/viewport-3d/layers/VectorFieldLayer.test.ts
```

Acceptance:

- full glyph count/scale/color semantics match baseline;
- no unbounded matrix/color upload loop remains in layer code.

### Phase 4: Derived Buffer Cache Completion

Goal: make stale presentation honest and memory bounded.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.ts`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.test.ts`

Steps:

- [ ] Add revision-scoped eviction for stale topology generations.
- [ ] Add field-generation eviction policy.
- [ ] Add memory-pressure eviction tests.
- [ ] Add release-on-unmount tests for each retained layer.
- [ ] Add stale-physical visible/target revision tests.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.test.ts
```

Acceptance:

- previous buffers can keep UI responsive without hiding that they are stale.

### Phase 5: GPU Upload Integration

Goal: prevent worker results from freezing UI during WebGL upload.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.test.ts`
- Test: layer tests next to each modified layer.

Steps:

- [ ] Verify upload manager fake-timer tests for bounded chunks.
- [ ] Integrate vector glyph matrix upload.
- [ ] Integrate vector glyph color upload.
- [ ] Integrate field color upload.
- [ ] Integrate overlay/index uploads where applicable.
- [ ] Add abort-before-visible tests.
- [ ] Add diagnostics for upload frames and bytes.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/build-engine/gpu src/modules/viewport-3d/layers/VectorFieldLayer.test.ts
```

Acceptance:

- Fullmag-owned upload slices stay within configured budget in tests.

### Phase 6: Topology Index Lane

Goal: isolate topology work from field updates and camera interaction.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexScheduler.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexWorker.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DTopologyIndexBundle.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexScheduler.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DTopologyIndexBundle.test.ts`

Steps:

- [ ] Key topology index by topology revision and mapping revisions.
- [ ] Route topology build through scheduler lane.
- [ ] Cache topology handle.
- [ ] Prove field revision does not rebuild topology.
- [ ] Prove camera movement does not schedule topology build.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewport3dTopologyIndexScheduler.test.ts src/modules/viewport-3d/hooks/useViewport3DTopologyIndexBundle.test.ts
```

Acceptance:

- topology work occurs only for topology-relevant changes.

### Phase 7: Region Overlay Lane

Goal: move region overlay derivation out of main thread.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildModel.ts`
- Create: `apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildWorker.ts`
- Create: `apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildScheduler.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/RegionMeshOverlayLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildModel.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/RegionMeshOverlayLayer.test.tsx`

Steps:

- [ ] Extract pure overlay model from layer code.
- [ ] Add worker wrapper.
- [ ] Add semantic keys.
- [ ] Add cache/adoption handle.
- [ ] Preserve authored primitive overlay while realized overlay builds.
- [ ] Add degraded mapping diagnostics.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/region-overlays src/modules/viewport-3d/layers/RegionMeshOverlayLayer.test.tsx
```

Acceptance:

- region overlays remain full quality and no longer create unbounded main-thread windows.

### Phase 8: Field Color Lane

Goal: make scalar/vector color updates worker-built and upload-budgeted.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts`
- Create: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildWorker.ts`
- Create: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildScheduler.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.test.ts`

Steps:

- [ ] Extract pure color mapping.
- [ ] Include quantity/component/color range/style in key.
- [ ] Use backend stats when present.
- [ ] Compute missing stats in worker.
- [ ] Return transferable color buffer.
- [ ] Upload through GPU upload manager.
- [ ] Preserve color quality and range semantics.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/field-colors src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.test.ts
```

Acceptance:

- field color updates do not produce multi-second long tasks.

### Phase 9: R3F Layer Cleanup

Goal: make layers stable consumers of handles.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Test: source-level tests under `apps/control-room/src/modules/viewport-3d/layers/`

Steps:

- [ ] Search for large typed-array allocation in render and broad `useMemo`.
- [ ] Move heavy builders to lanes.
- [ ] Replace large React state with refs/cache handles.
- [ ] Add cleanup release tests.
- [ ] Prove camera-only changes do not run heavy builders.
- [ ] Prove quantity switches do not recreate topology geometry.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers
```

Acceptance:

- React render cost is not proportional to mesh element count or glyph count.

### Phase 10: Interaction Responsiveness Audit

Goal: prove pan/orbit/zoom remain responsive during build/upload work.

Files:

- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Test: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

Steps:

- [ ] Add scripted camera pan gesture.
- [ ] Add scripted orbit gesture.
- [ ] Add scripted zoom gesture.
- [ ] Record max frame window for each gesture.
- [ ] Record worker/upload activity during gesture.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Acceptance:

- pan is not materially worse than orbit due to application-owned work;
- if browser controls themselves dominate, artifact says so.

### Phase 11: Tools UI

Goal: expose diagnostics professionally without requiring UI interaction for recording.

Files:

- Modify: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderDialog.tsx`
- Modify: `apps/control-room/src/modules/footer/DiagnosticRecorderFooterPanel.tsx`
- Modify: `apps/control-room/src/design/styles/diagnostic-recorder.css`
- Test: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderDialog.test.tsx`
- Test: `apps/control-room/src/modules/footer/DiagnosticRecorderFooterPanel.test.tsx`

Steps:

- [ ] Add lane status summary.
- [ ] Add worker pool summary.
- [ ] Add GPU upload summary.
- [ ] Add cache byte summary.
- [ ] Add visible/target revision summary.
- [ ] Add stale-physical warning state.
- [ ] Add export/copy suspect report controls.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/layout/diagnostic-recorder src/modules/footer/DiagnosticRecorderFooterPanel.test.tsx
```

Acceptance:

- UI is useful for humans but recorder remains boot-start and scriptable.

### Phase 12: End-To-End CofeB Diagnostic Gate

Goal: prove the real problem is solved or identify the remaining dominant lane.

Files:

- Modify: `justfile` only if a stable recipe is missing.
- Modify: `apps/control-room/scripts/record-diagnostics.mjs`

Steps:

- [ ] Run short CofeB relaxation scenario with full 3D.
- [ ] Start recorder before page load.
- [ ] Capture first 3D ready.
- [ ] Perform camera pan/orbit/zoom.
- [ ] Trigger or wait for field update.
- [ ] Capture idle window.
- [ ] Export artifact.
- [ ] Compare against baseline.
- [ ] Save suspect report and screenshot evidence.
- [ ] Run:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Acceptance:

- no Fullmag-owned multi-second freeze remains;
- if a freeze remains, next fix is chosen from artifact evidence, not guesswork.

### Phase 13: Memory Stress Gate

Goal: prove repeated usage does not leak.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/viewport-memory-stress.test.ts`
- Modify: `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs`
- Test: `apps/control-room/src/modules/viewport-3d/viewport-memory-stress.test.ts`

Steps:

- [ ] Mount 3D viewport.
- [ ] Load full field/topology resources.
- [ ] Switch quantities repeatedly.
- [ ] Switch 3D -> cross-section -> analysis plots -> 3D.
- [ ] Toggle relevant layers.
- [ ] Select and clear objects.
- [ ] Unmount viewport.
- [ ] Assert worker/cache/WebGL resources return to baseline.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewport-memory-stress.test.ts
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

Acceptance:

- no unbounded memory/resource growth across repeated workflow.

### Phase 14: Server-Derived Visualization Resources

Goal: prepare large-model scalability without forking semantics.

Files:

- Modify: `docs/specs/resource-first-control-room-api-v2.md`
- Create: `docs/superpowers/plans/2026-06-24-control-room-server-derived-viewport-resources.md`
- Modify: backend OpenAPI/schema files named by that scoped server-derived resource plan.
- Modify: generated frontend API facade after the schema update.
- Create: `apps/control-room/src/modules/viewport-3d/build-engine/serverDerived/viewport3dServerDerivedAdapter.ts`
- Test: resource hook and equivalence tests.

Candidate resources:

```text
GET /v2/sessions/current/visualization/derived/topology-index
GET /v2/sessions/current/visualization/derived/field-colors
GET /v2/sessions/current/visualization/derived/vector-glyphs
GET /v2/sessions/current/visualization/derived/region-overlays
```

Steps:

- [ ] Write spec update before API implementation.
- [ ] Use same build-key contract as browser workers.
- [ ] Add provenance origin.
- [ ] Keep browser worker fallback.
- [ ] Add browser/server equivalence fixtures.
- [ ] Add binary resource hooks.

Acceptance:

- server-derived buffers accelerate large cases without changing visible semantics.

### Phase 15: CI And Governance

Goal: stop regressions from returning.

Files:

- Modify: `apps/control-room/package.json`
- Modify: `.github/workflows/contract-guard.yml`
- Modify: `docs/specs/frontend-v2/17-performance-memory-profiler.md`

Steps:

- [ ] Add stable test script for viewport build-engine unit tests.
- [ ] Add stable test script for viewport memory stress.
- [ ] Add smoke script for WebGL viewport readiness.
- [ ] Add diagnostic artifact schema test.
- [ ] Document performance budgets.
- [ ] Document required evidence for claiming a performance fix.

Acceptance:

- future viewport changes must pass lifecycle/performance gates before merge.

### Phase 16: Production Rollout And Removal Of Diagnostic Crutches

Goal: make the optimized path the normal product path and remove temporary
diagnostic switches from user-facing defaults.

Files:

- Create: `apps/control-room/src/modules/viewport-3d/viewport3dFeatureFlags.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts`
- Modify: `docs/specs/frontend-v2/17-performance-memory-profiler.md`
- Modify: this plan and the active build-engine tracker.

Steps:

- [ ] List every viewport performance/debug feature flag.
- [ ] Mark each flag as `diagnostic-only`, `temporary-rollout`, or `production`.
- [ ] Add owner and removal condition for each temporary flag.
- [ ] Make full-quality path the default.
- [ ] Keep layer-disable switches only in diagnostic profiles.
- [ ] Add a source-level test that no production default disables mesh, vectors, field colors, overlays, airbox or HUD for performance.
- [ ] Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
```

Acceptance:

- the optimized path is not hidden behind a local-only debug flag;
- no performance win depends on permanently disabling a visual layer.

### Phase 17: Regression Playbook

Goal: make future freezes fast to diagnose.

Files:

- Create: `docs/runbooks/control-room-viewport-3d-freeze-diagnostics.md`
- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Modify: `justfile`

Steps:

- [ ] Document how to run the short CofeB diagnostic.
- [ ] Document how to read `suspect-report.md`.
- [ ] Document how to classify freezes by lane.
- [ ] Document how to compare two artifacts.
- [ ] Add just recipe alias only if the existing recipe name is too long for regular use.
- [ ] Include expected healthy thresholds and known acceptable browser noise.

Acceptance:

- a future agent can reproduce, capture and classify a viewport freeze without
  asking the user to manually inspect the browser console.

## 18. Verification Commands

Targeted during implementation:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/build-engine
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewport-memory-stress.test.ts
pnpm --dir apps/control-room exec vitest run src/kernel/performance
```

Frontend gates:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
git diff --check
```

Browser smoke:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Real diagnostic gate:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

## 19. Metrics To Track

Startup:

- time to first workspace shell;
- time to first viewport canvas;
- time to first full-quality 3D ready;
- max boot long task;
- max boot long animation frame.

Build engine:

- jobs per lane;
- aborted jobs;
- obsolete drops;
- queue wait max/p95;
- worker compute max/p95;
- transfer max/p95;
- output bytes;
- cache hit/miss.

GPU upload:

- upload tickets;
- upload bytes;
- chunks per ticket;
- frames per ticket;
- max upload slice duration;
- budget exceeded count.

Interaction:

- pan max frame window;
- orbit max frame window;
- zoom max frame window;
- pointer event delay where available;
- dirty reasons during interaction.

Idle:

- frames after settling;
- requests after settling;
- long tasks after settling;
- active workers after settling;
- active resource hooks.

Memory:

- cache bytes;
- typed array estimate;
- WebGL geometry count;
- material count;
- texture count;
- worker count;
- object URLs;
- resource-cache entries.

Quality:

- layer presence in final screenshot;
- vector glyph count and sampling profile;
- scalar color range and color-map identity;
- region overlay mode and object/part coverage;
- airbox surface and full-volume wireframe state;
- HUD/bounds/selection visibility;
- screenshot comparison notes when a visual output changes intentionally.

### 19.1 Hard Budgets

Initial hard budgets for production acceptance:

| Metric | Target | Gate |
|---|---:|---|
| Idle viewport frames after settle | `0` | fail if continuous frames remain |
| Fullmag-owned idle API polling | `0` | fail if periodic polling appears |
| Repeated idle long tasks | `0` | fail |
| GPU upload slice target | `<= 3 ms` | warn above target, fail repeated misses |
| GPU upload slice max | `<= 5 ms` | fail repeated misses |
| Active worker count after settle | `0` or idle pool baseline | fail if stale busy worker remains |
| WebGL context after smoke | not lost | fail |
| Drawing buffer after smoke | non-zero | fail |
| Layer-disable production defaults | none | fail |

The `100 ms` long-task threshold is a diagnostic ceiling, not a success target.
The intended steady-state path should be far below it. Any Fullmag-owned
multi-second main-thread stall is a release blocker.

### 19.2 Scenario Matrix

Every major change should be evaluated against this matrix:

| Scenario | Required evidence |
|---|---|
| Cold boot with no clicking | boot-start artifact, first 3D screenshot, suspect report |
| Full 3D first ready | layer screenshot and visible/target revision summary |
| Camera pan during build | gesture timing and no heavy key changes |
| Camera orbit during build | gesture timing and comparison to pan |
| Quantity switch | topology cache hit and field/glyph rebuild only |
| Field revision update | stale-physical state then current adoption |
| Topology revision update | topology-dependent invalidation only |
| Region overlay toggle | overlay lane work only |
| 3D -> non-3D tab -> 3D | resource release and remount evidence |
| Worker unavailable fallback | bounded fallback and explicit degraded diagnostic |
| WebGL context loss | recovery or failing smoke evidence |
| Memory stress loop | bounded cache/WebGL/worker counts |

## 20. Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Worker pool uses too many cores | Browser input remains sluggish | conservative `maxTotalWorkers`, lane limits, diagnostics |
| Worker transfer doubles memory | Memory spikes on large FEM cases | transfer ownership where safe, byte accounting, cache eviction |
| GPU upload becomes the freeze | Worker output still blocks WebGL adoption | frame-budgeted upload manager |
| Stale visuals mislead user | User sees old physics as current | explicit visible/target revision and stale-physical status |
| Diagnostics overhead causes freeze | Tool changes the measured system | bounded records, dropped counts, event-driven capture |
| React snapshot churn rerenders module | UI cost remains high despite workers | stable `useSyncExternalStore` snapshots and primitive deps |
| Cache leaks FEM buffers | Repeated use consumes memory | ref counting, eviction, memory stress |
| Server-derived resources drift | Browser/server output differs | shared keys, equivalence tests, provenance |
| Feature flags become product path | Diagnostic switches hide real bugs | owner/removal criteria, final full-quality gate |
| Context loss hidden as harmless | Broken viewport passes tests | browser smoke checks context and drawing buffer |

## 20.1 Rollback And Safety Plan

Rollback must preserve debuggability:

- keep the old synchronous path only behind a diagnostic comparison flag while
  the new lane is being validated;
- never remove a diagnostic record before the replacement record exists;
- if a lane causes incorrect visuals, disable only that new lane and fall back
  to the previous full-quality path for that lane;
- do not roll back by disabling the visual layer itself;
- keep artifacts from failed attempts in `.fullmag/reports/...` until the next
  successful comparison is recorded.

Rollback decision rules:

| Failure | Correct rollback |
|---|---|
| wrong colors | revert field-color lane adoption, keep layer visible |
| missing glyphs | revert glyph handle adoption, keep previous glyph path |
| stale data shown as current | block adoption and fix revision state |
| memory leak | disable new cache retention for that lane, keep direct full-quality path |
| upload budget regression | reduce upload slice size or restore previous adoption path for that lane |
| worker crash | use bounded fallback and record crash reason |

## 20.2 Feature Flag Policy

Allowed flags:

- diagnostic layer isolation;
- rollout selection between old/new lane implementation;
- forced worker fallback for tests;
- upload budget stress mode;
- artifact verbosity level.

Required metadata:

```ts
export interface Viewport3DFeatureFlagMetadata {
  readonly id: string;
  readonly owner: "viewport-3d" | "diagnostics" | "performance";
  readonly category: "diagnostic-only" | "temporary-rollout" | "production";
  readonly defaultEnabled: boolean;
  readonly removalCondition: string;
  readonly disablesVisualQuality: boolean;
}
```

Rules:

- `disablesVisualQuality: true` is allowed only for `diagnostic-only`;
- temporary rollout flags must have removal conditions;
- production defaults must render full quality;
- CI/source tests should fail if a production default disables a visual layer.

## 21. Banned Shortcuts

- Do not reduce visual quality as the primary fix.
- Do not hide expensive layers in production to pass diagnostics.
- Do not silence diagnostics because they reveal a slow path.
- Do not turn the viewport into always-on animation to hide stale frames.
- Do not store large buffers in React state.
- Do not hand-roll API endpoint strings in viewport layers.
- Do not fork FDM and FEM renderers.
- Do not claim worker wall time is main-thread freeze without evidence.
- Do not claim success from unit tests alone.
- Do not leave diagnostic logs unbounded.

## 22. Definition Of Done

The work is done only when:

- all planned full-quality layers render in final screenshot;
- no Fullmag-owned multi-second freeze remains in CofeB diagnostic artifact;
- pan/orbit/zoom are measured under build/upload load;
- idle viewport frames settle to zero;
- memory stress shows bounded resources;
- browser smoke passes;
- `typecheck`, `lint`, `test` and `git diff --check` pass;
- suspect report explains the remaining top costs, even if they are acceptable;
- plan/spec documents match implementation.

## 22.1 Go/No-Go Checklist For Each Phase

Before implementation:

- [ ] The phase has a baseline or a failing test.
- [ ] The phase states which lane/owner it changes.
- [ ] The phase states which visual quality must be preserved.
- [ ] The phase states the diagnostic record that will prove the behavior.

Before merge:

- [ ] Targeted tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] Full test suite passes or skipped command is explained.
- [ ] `git diff --check` passes.
- [ ] Browser smoke passes for viewport work.
- [ ] Screenshot or artifact proves the visual layer is still present.
- [ ] Plan tracker is updated.

Before claiming performance improvement:

- [ ] Baseline artifact path is recorded.
- [ ] New artifact path is recorded.
- [ ] Same scenario was used.
- [ ] Long task and long animation frame numbers are compared.
- [ ] Dominant suspect lane changed in the expected direction.
- [ ] No visual layer was disabled to achieve the result.

## 23. First Draft Self-Review

First draft weakness:

- too much emphasis on workers alone;
- not enough emphasis on WebGL upload as a separate bottleneck;
- stale presentation could have become scientifically misleading;
- diagnostics could confuse worker wall time with main-thread blocking;
- cache lifecycle could leak large FEM buffers;
- future server-derived resources could fork semantics;
- Tools UI could accidentally become always-on overhead.

Corrections applied in this final plan:

- GPU upload manager is a first-class phase;
- stale states are explicit and part of the cache contract;
- diagnostics split queue, worker, transfer, adoption and upload;
- cache requires ref counting, byte estimates and memory stress;
- server-derived resources must use the same build keys and equivalence tests;
- Tools UI is secondary to boot-start recording and must stay bounded;
- acceptance requires real CofeB artifact evidence.

## 23.1 Second-Pass Review After Re-Reading The Plan

I re-read the plan as if it would be handed to another senior engineer. The
places most likely to fail in real production were not the algorithmic pieces;
they were ownership drift and unclear rollout. I tightened those areas:

- added explicit plan classification so this cannot be mistaken for one giant
  patch;
- added professional reference model so the design is anchored in proven CAE
  architecture patterns;
- added alternatives and rejection reasons so future work does not drift back
  to layer disabling or memoization-only fixes;
- added maturity levels so progress is measurable even before the final L5
  architecture exists;
- added ownership matrix so files do not slowly regain mixed responsibility;
- added rollout and regression phases so the work ends in a maintainable
  production path, not a pile of debug flags;
- added hard budgets and scenario matrix so performance is tested as workflows,
  not as isolated micro-optimizations;
- added rollback and feature-flag policy so failure recovery preserves visual
  quality instead of hiding layers.

Remaining deliberate constraint:

- this plan does not invent backend file paths for future server-derived
  resources. That phase must begin with a scoped API/spec plan when we decide
  to implement it. Fabricating exact backend paths here would be false
  precision.

## 24. Final Confidence Review

I am confident this is the right production architecture because it addresses the actual failure class: expensive visualization work is currently insufficiently owned, scheduled, cached, uploaded and attributed. The solution is not a visual compromise; it is a proper execution pipeline for high-quality scientific visualization.

What cannot be claimed until measured:

- exact final freeze duration;
- exact speedup percentage;
- whether the remaining dominant cost after vector/upload work is field color, topology, region overlay, React, browser driver or backend data path.

The plan is therefore 100% professional in strategy, but intentionally evidence-gated in outcome. Every claim of improvement must come from the recorded artifact.

## 25. Recommended Execution Order

1. Finish current build-engine tracker through vector glyph upload integration.
2. Run targeted build-engine and vector tests.
3. Run typecheck/lint/full tests.
4. Run browser smoke.
5. Run CofeB diagnostic artifact.
6. If freeze remains, classify it by lane.
7. Implement the next dominant lane: field color, topology, region overlay, upload or React cleanup.
8. Repeat until the artifact shows no Fullmag-owned multi-second freeze.
9. Add memory stress and CI gates.
10. Only then consider server-derived resources for larger-than-browser-local workloads.

## 26. Production Architecture Detail Pack

This section expands the plan from "what to build" into "how the system must
behave in production". It exists because the failure mode we are fixing is not
one slow function. It is a missing execution model for expensive scientific
visualization.

The production architecture must be treated as five cooperating systems:

1. resource acquisition;
2. visualization derivation;
3. GPU presentation;
4. interaction responsiveness;
5. forensic diagnostics and lifecycle control.

Each system has its own owner, state machine, budgets and evidence. If these
systems blur together again, the browser freeze will return.

### 26.1 Professional CAE-Class Pattern

Large scientific/CAE applications generally separate the user's physical model
from the viewport's derived representation. Fullmag should follow that class of
architecture:

- solver results remain canonical physical data;
- visualization buffers are derived products with explicit provenance;
- heavy postprocessing is queued, cancellable and cacheable;
- presentation keeps the last safe visible state while a newer state builds;
- UI interaction has higher scheduling priority than visualization preparation;
- diagnostics report the exact stage that consumed time or memory.

The browser is not a numerical backend and not an unbounded postprocessor. It
is the control room and final presentation layer. It can perform local derived
work, but only through a bounded, observable and abortable pipeline.

### 26.2 The Core Production Rule

Every expensive operation must answer these questions before it is allowed into
the viewport path:

| Question | Required answer |
|---|---|
| What semantic key identifies this result? | stable build key |
| What resource revisions does it depend on? | topology, field, target, style, sampling |
| Can it be deduped? | scheduler group key |
| Can it be aborted? | abort signal and obsolete-result drop |
| Can the previous result remain visible? | stale-compatible or stale-physical classification |
| Where is it computed? | worker, chunked main fallback, or server-derived resource |
| How is it uploaded? | GPU upload ticket and budget |
| Who owns memory? | cache handle, layer handle, WebGL tracker |
| How is it released? | release trigger and stress test |
| How is it diagnosed? | timeline/build/upload/memory records |

If one answer is missing, the feature is not production-ready.

### 26.3 Quality Preservation Doctrine

The optimized path must produce the same scientific visualization semantics as
the current full-quality path.

Quality that must be preserved:

- magnetic object mesh surfaces;
- magnetic object wireframes;
- scalar field colors and color ranges;
- vector glyph density, scale, color and target scoping;
- region overlays and object/part mapping;
- airbox surface and full-volume wireframe contract;
- bounds, axes, orientation HUD and dimension frame;
- selection/highlight behavior;
- final screenshot fidelity for the same resource revisions.

Permitted temporary states:

- "loading derived buffer";
- "previous compatible style visible";
- "previous physical field visible while current field builds";
- "backend mapping incomplete, fallback overlay shown";
- "worker unavailable, bounded main-thread fallback active".

Not permitted:

- reporting stale data as current;
- silently hiding a layer to make a profile pass;
- lowering glyph density without a user-visible diagnostic profile;
- permanently using a preview-quality path as the default;
- claiming optimization success without final full-quality screenshot evidence.

### 26.4 Pipeline Ownership Diagram

```text
User intent / visualization state
  owner: v2 resources + command registry
  output: small canonical control snapshot

Heavy numerical resources
  owner: typed resource hooks + binary resource cache
  output: topology, field, manifest and mapping buffers

Semantic render model
  owner: viewport render-model builders
  output: small references, revisions, display config

Build engine
  owner: viewport build-engine modules
  output: immutable derived buffer handles

GPU upload manager
  owner: viewport GPU upload modules
  output: uploaded/adoptable presentation handles

R3F layers
  owner: layer components + resource tracker
  output: visible Three.js objects/materials

Diagnostics
  owner: diagnostic recorder + viewport diagnostics
  output: bounded records, summaries and suspect report
```

No arrow may point backwards from R3F layers into API fetches or heavy derived
work. Layers can request work through handles/keys; they cannot become the
postprocessor.

## 27. Runtime State Machines

The implementation should be driven by explicit state machines. Hidden boolean
combinations are the source of stale state bugs.

### 27.1 Build Job State

```text
idle
  -> queued
  -> dependency-wait
  -> running-worker
  -> transferring
  -> adopting-main
  -> cached-ready
  -> upload-queued
  -> uploading
  -> visible-ready
```

Abort paths:

```text
queued -> aborted-obsolete
dependency-wait -> aborted-obsolete
running-worker -> abort-requested -> aborted-obsolete
transferring -> dropped-obsolete
adopting-main -> dropped-before-visible
upload-queued -> upload-aborted
uploading -> upload-aborted-before-visible
```

Failure paths:

```text
running-worker -> worker-failed -> bounded-fallback | failed-visible-unchanged
uploading -> upload-failed -> failed-visible-unchanged
```

Diagnostic requirement:

- every terminal state records why it ended;
- obsolete results record the newer group key that superseded them;
- failed jobs do not clear the last good visible handle unless the previous
  handle is semantically invalid.

### 27.2 Visible Handle State

```text
none
  -> pending-first-current
  -> visible-current
  -> visible-stale-compatible
  -> visible-stale-physical
  -> invalid-hidden
  -> released
```

Rules:

- `visible-current` means visible key exactly matches target key;
- `visible-stale-compatible` means the physical resource revision still matches
  but a style/sampling output is being rebuilt;
- `visible-stale-physical` means an older physical resource is visible and must
  be surfaced in diagnostics/UI;
- `invalid-hidden` is allowed only when showing old data would be scientifically
  misleading;
- `released` handles cannot be readopted.

### 27.3 GPU Upload State

```text
not-needed
  -> upload-ticket-created
  -> upload-waiting-for-frame-budget
  -> upload-slice-running
  -> upload-slice-yielded
  -> upload-complete
  -> visible-adopted
```

Rules:

- upload tickets are abortable before visible mutation;
- upload work is chunked when item/byte count exceeds budget;
- each slice records duration, bytes and item count;
- budget misses record the caller/lane and the browser frame context.

### 27.4 Viewport Module State

```text
unmounted
  -> mounting
  -> waiting-for-resources
  -> building-derived
  -> first-visible
  -> full-quality-ready
  -> interacting
  -> idle-settled
  -> unmounting
  -> unmounted
```

Rules:

- `full-quality-ready` cannot be set while required layers are hidden for
  performance;
- `idle-settled` requires no pending jobs, no upload tickets, no unexpected
  frames and no active unowned worker;
- `unmounting` aborts jobs and releases handles before the module disappears
  from diagnostics.

## 28. Backpressure And Scheduling Policy

The browser must have a quality-of-service model. Without it, a correct worker
pipeline can still make interaction feel bad by saturating CPU, transfer or GPU
upload.

### 28.1 Priority Classes

| Priority | Examples | Policy |
|---|---|---|
| P0 user input | camera pan/orbit/zoom, menu click, cancel | never blocked by build queue |
| P1 visible correction | current topology/field replacing stale physical data | scheduled before optional derived views |
| P2 core visualization | field colors, glyphs, region overlays for active view | bounded concurrent work |
| P3 secondary visualization | mesh quality, optional overlays, expensive stats | runs after P1/P2 settle |
| P4 diagnostics export | artifact compression, report rendering | idle or explicit user action |

### 28.2 Backpressure Rules

- if the build queue is full, drop obsolete latest-wins jobs before rejecting
  current jobs;
- if GPU upload misses budget repeatedly, reduce per-slice byte/item budget;
- if workers saturate CPU and input latency increases, keep visual quality but
  reduce concurrency, not output fidelity;
- if memory pressure rises, evict released/stale entries and abort queued
  optional jobs before touching visible current handles;
- if diagnostics volume rises, drop detailed records with dropped counts while
  preserving summary records.

### 28.3 What Backpressure Must Not Do

- it must not disable a visible layer silently;
- it must not change color ranges or glyph density;
- it must not skip physical field revisions without recording the visible/target
  revision gap;
- it must not make the render loop continuous.

## 29. Memory And Resource Ownership Contracts

Memory correctness is as important as frame time. A faster viewport that leaks
large FEM buffers is not production-ready.

### 29.1 Ownership Ledger

Every large resource needs a ledger entry:

| Resource kind | Owner | Retain | Release |
|---|---|---|---|
| topology typed arrays | resource cache | resource hook consumer | resource eviction/unmount |
| field typed arrays | resource cache | active quantity/lane | resource eviction/unmount |
| derived color buffers | derived-buffer cache | layer handle | revision eviction/unmount |
| glyph transform buffers | derived-buffer cache | vector layer handle | revision eviction/unmount |
| overlay buffers | derived-buffer cache | overlay layer handle | revision eviction/unmount |
| BufferGeometry | R3F layer/tracker | layer mounted | topology/style change/unmount |
| BufferAttribute | R3F layer/tracker | visible handle | upload replacement/unmount |
| material/texture | R3F layer/tracker | layer mounted | style change/unmount |
| worker | worker pool | active/idle lease | idle timeout/dispose |
| diagnostic record buffer | diagnostic recorder | active capture | bounded eviction/export |

### 29.2 Memory Budget Classes

| Class | Examples | Action on pressure |
|---|---|---|
| current-visible | visible geometry/color/glyph buffers | protect unless semantically invalid |
| current-not-visible | current derived buffers hidden by layer state | evict if rebuild is cheap or hidden |
| stale-compatible | previous style buffers | evict before current buffers |
| stale-physical | previous physical revision buffers | evict when replacement visible or pressure high |
| pending-worker-output | results waiting for adoption/upload | abort if obsolete |
| diagnostics-detail | verbose timeline events | summarize/drop details first |

### 29.3 Memory Stress Acceptance

The memory stress gate should fail if any of these grow unbounded across loops:

- active workers;
- queued jobs;
- cache entries;
- retained handles;
- WebGL geometries;
- WebGL materials;
- textures;
- object URLs;
- viewport event listeners;
- diagnostic record arrays;
- typed array byte estimates.

## 30. Visual Correctness Tests

Performance work needs visual correctness gates, not only timing gates.

### 30.1 Source-Level Tests

Add source-level tests where browser-level equality is hard:

- production defaults do not disable visual layers;
- field revision changes do not rebuild topology;
- camera changes do not alter heavy build keys;
- obsolete worker results cannot call visible adoption;
- upload abort happens before mutation;
- stale-physical state is recorded when previous field stays visible.

### 30.2 Model-Level Tests

Add pure tests for build models:

- field color mapping matches existing color semantics for representative
  scalar/vector inputs;
- glyph transform output matches current orientation/scale semantics;
- region overlay grouping matches current object/part mapping semantics;
- topology index output is independent of field revision;
- airbox full-volume wireframe contract is preserved.

### 30.3 Browser-Level Tests

Browser smoke must prove:

- canvas exists;
- WebGL context is not lost;
- drawing buffer is non-zero;
- final viewport screenshot includes the required layers;
- camera pan/orbit/zoom still render;
- no continuous idle frames after settle;
- no console maximum-update-depth or diagnostic-recorder loop regression.

## 31. Diagnostic Triage Model

The final artifact should make the next action obvious. It should classify the
dominant freeze into one of these buckets.

| Bucket | Evidence | Next action |
|---|---|---|
| resource/network | slow request, no local long task | backend/data-plane investigation |
| binary decode | decode time high, worker absent or slow | decode lane/transferables |
| topology index | topology lane dominates | topology worker/cache/server-derived candidate |
| field color | color lane dominates | field-color worker/upload/range stats |
| vector glyph | glyph lane dominates | glyph worker pool/upload/adoption |
| region overlay | overlay lane dominates | overlay worker/key/cache |
| GPU upload | upload slices or adoption dominate | chunk upload, reduce slice size, atomic adoption |
| React rerender | React commit high, build lanes quiet | snapshot stability, component deps |
| R3F frame | frame high after upload | layer object count/material/shader analysis |
| diagnostics overhead | recorder work dominates | lower verbosity, summarize, move export to idle |
| browser/driver | app work quiet, browser frame still huge | trace/context/driver investigation |

The suspect report must name the top bucket and show why it was chosen.

## 32. UI And Operator Experience

The diagnostic tool must be usable by a developer and by a scientist who only
wants to know whether the visualization is current.

### 32.1 Always-Automated Capture

Recording must be scriptable and boot-started. Manual clicking in the browser
is not part of the core diagnostic path.

Required automation:

- launch simulation;
- launch frontend;
- open workspace;
- record from navigation start;
- wait for first 3D ready;
- perform scripted camera gestures;
- wait for idle;
- export artifact.

### 32.2 Tools UI

Tools UI is for inspection and export, not for starting the only valid capture.

It should show:

- recording status;
- current scenario id;
- top suspects;
- active lanes;
- worker pool state;
- upload queue;
- cache bytes;
- visible vs target revisions;
- stale state;
- export/copy controls.

It should not:

- poll continuously;
- render thousands of timeline rows live;
- store raw logs in React state;
- require being open for recording to work.

### 32.3 Viewport Status UI

The viewport should expose a compact status for professional honesty:

- `3D ready`;
- `building field colors`;
- `building glyphs`;
- `uploading derived buffers`;
- `showing previous field while current field builds`;
- `diagnostic fallback active`;
- `full quality current`.

The UI text can be compact. The important part is that stale physical data is
not silently presented as current.

## 33. Server-Derived Resource Strategy

Browser workers are the first production step because they fix ownership and
diagnostics without expanding backend scope. Server-derived resources are the
next scale step once the browser contract is proven.

### 33.1 When To Move A Lane Server-Side

Move a lane server-side only when evidence shows at least one of:

- browser worker compute remains too high for target cases;
- transfer from backend already contains enough information to derive the buffer
  more cheaply near the solver output;
- memory pressure from client-side derived buffers is unacceptable;
- derived result can be reused across clients or exported as an artifact.

### 33.2 Server-Derived Contract

Server-derived resources must:

- use the same semantic build keys;
- produce equivalent visual output;
- report provenance origin;
- remain optional;
- keep browser worker fallback;
- be binary data-plane resources, not huge JSON;
- have equivalence fixtures against browser builders.

### 33.3 What Not To Do Server-Side

- do not create a second visualization semantics contract;
- do not bypass resource-first API;
- do not make browser and backend choose different color/glyph semantics;
- do not require server-derived resources for normal small/medium cases;
- do not introduce hidden solver-specific display behavior.

## 34. Execution Governance For Agents

This plan is broad enough that careless execution would create risky diffs. The
work must be sliced.

### 34.1 Slice Rules

Each implementation slice must:

- change one lane or one infrastructure owner;
- start with a failing test or baseline artifact;
- preserve full-quality output;
- update the tracker;
- run targeted tests;
- run typecheck/lint/full tests before claiming done;
- run browser smoke for viewport-affecting code;
- record why any command was not run.

### 34.2 Review Rules

Review each slice for:

- whether any line lowers visual quality;
- whether large arrays entered React state;
- whether a worker/cache/upload handle lacks release;
- whether stale state is explicit;
- whether diagnostics can explain the new path;
- whether fallback paths are bounded and visible;
- whether test coverage proves no obsolete result can become visible.

### 34.3 Commit Strategy

Recommended commit grouping:

1. diagnostics/schema;
2. scheduler/cache/gpu infrastructure;
3. one lane at a time;
4. layer adoption cleanup;
5. browser diagnostics and memory stress;
6. docs/runbook/governance.

Do not mix a field-color lane rewrite with unrelated UI styling or backend API
experiments.

## 35. Final Third-Pass Professional Review

After re-reading the plan again, the strongest version is not "move everything
to workers". The strongest version is:

```text
stable semantic keys
  + bounded scheduling
  + explicit stale state
  + immutable derived cache
  + frame-budgeted GPU upload
  + strict resource ownership
  + boot-start forensic diagnostics
  + full-quality visual acceptance
```

This is the production solution because it attacks every known path that can
freeze the browser:

- CPU computation is moved off main thread or chunked;
- worker concurrency is bounded so it does not starve input;
- transfer/adoption is measured and cancellable;
- GPU upload is treated as a first-class bottleneck;
- React receives small stable snapshots, not large mutable buffers;
- stale data is explicit, so responsiveness does not become scientific lying;
- memory lifecycle is tested, so optimization does not become a leak;
- diagnostics start at boot, so we can debug together from an artifact rather
  than from manual console screenshots.

The plan deliberately does not promise a fake numeric speedup before the
diagnostic artifact exists. That is the professional stance. It defines the
system that can produce the evidence, then requires the evidence before any
success claim.

### 35.1 Final Confidence Statement

I am confident this is the correct production architecture for Fullmag's
Control Room viewport because it preserves visual quality and fixes the real
engineering boundary: ownership of expensive visualization work. It is aligned
with the existing v2 specs: resource-first API, one domain-neutral viewport,
demand rendering, explicit resource cleanup and measured performance gates.

The only remaining uncertainty is empirical: which lane will dominate after the
current build-engine work lands. The plan handles that uncertainty by making
the diagnostic artifact the decision-maker.

## 36. Requirement Traceability Matrix

This section maps the user's product requirements to the production architecture
so future implementation work cannot accidentally solve a narrower problem.

| Requirement | Production answer | Evidence gate |
|---|---|---|
| Browser must not freeze during initial GUI load | boot-start recorder, build lanes, GPU upload tickets, idle audit | cold CofeB artifact and suspect report |
| Logs must start without clicking in browser | diagnostic script injects recorder before workspace interaction | artifact has navigation-start and boot records |
| Full 3D quality must remain | quality preservation doctrine and source-level defaults test | final screenshot includes all required layers |
| We need to find every frontend bottleneck | suspect model splits resource, decode, worker, transfer, adoption, upload, React, R3F, driver and diagnostics | `suspect-report.md` names top bucket with supporting timings |
| 3D visualization deserves special attention | dedicated lanes for topology, field colors, vector glyphs, region overlays, airbox/bounds and picking | lane summaries in `viewport-3d-build.ndjson` |
| Camera interaction must stay responsive | P0 input priority and no heavy key changes on camera-only state | scripted pan/orbit/zoom gesture metrics |
| Pan must not be much worse than orbit | interaction audit records both gestures under load | comparison table in summary |
| Do not optimize by disabling features | banned shortcuts, feature flag policy and production defaults test | source test and screenshot gate |
| Memory leaks must be found | ownership ledger, cache refs, memory stress, WebGL tracker | memory stress summary and resource baseline |
| We should be able to debug together from one log | complete artifact directory with timeline, requests, workers, upload, screenshots and suspect report | shared artifact path is enough to reproduce the diagnosis |
| Future larger cases must scale | same build-key contract can move lanes to server-derived binary resources | browser/server equivalence fixtures before backend rollout |

## 37. Professional Acceptance Levels

The plan should not be judged as a binary all-or-nothing patch. It should move
through explicit levels. Each level is useful, testable and shippable.

| Level | Name | Required state | Exit evidence |
|---|---|---|---|
| P0 | Baseline captured | current freeze is reproducible with full logging | baseline artifact path and summary |
| P1 | Attributed | major costs are separated by lane and phase | suspect report identifies the dominant bucket |
| P2 | Bounded | workers, queues, cache and uploads have hard limits | unit tests for limits and aborts |
| P3 | Responsive | camera interaction remains usable while buffers build | gesture metrics under build/upload load |
| P4 | Full-quality current | final visible state is full quality and current | screenshot plus visible/target revision summary |
| P5 | Leak-safe | repeated workflows return to resource baseline | memory stress artifact |
| P6 | Regression-proof | CI/runbooks prevent old failure modes returning | stable scripts, tests and runbook |
| P7 | Scalable | server-derived resources can replace browser lanes where needed | equivalence tests and provenance |

The first production target is P4 for the current CofeB rings case. P5 follows
immediately because a fast viewport that leaks buffers is not production-grade.

## 38. Diagnostic Artifact Schema Detail

The diagnostic artifact must be useful without a live browser session. It should
let an agent inspect files and decide the next fix.

### 38.1 `manifest.json`

Required fields:

```json
{
  "schemaVersion": 1,
  "scenarioId": "cofeb-rings-relax-full-3d-cold",
  "createdAt": "2026-06-24T00:00:00.000Z",
  "controlRoomUrl": "http://localhost:3100/workspace",
  "git": {
    "branch": "salvage/mixed-fem-viewport-35232294",
    "commit": "recorded-by-script",
    "dirty": true
  },
  "simulation": {
    "example": "examples/permalloy_layer_cofeb_rings_relax_300nm.py",
    "maxStepsPerStage": 10,
    "runtime": "gpu",
    "precision": "auto"
  },
  "capture": {
    "startedBeforeNavigation": true,
    "includesScreenshots": true,
    "includesChromiumTrace": true,
    "profile": "viewport-3d"
  }
}
```

The script should fill real branch/commit values. If the worktree is dirty, the
artifact must say so; dirty state is acceptable for diagnostics, but it must not
be hidden.

### 38.2 `summary.json`

Required top-level sections:

```json
{
  "bootSummary": {},
  "resourceSummary": {},
  "binaryDecodeSummary": {},
  "viewport3dBuildSummary": {},
  "viewport3dUploadSummary": {},
  "interactionSummary": {},
  "idleSummary": {},
  "memorySummary": {},
  "qualitySummary": {},
  "suspectSummary": {}
}
```

`qualitySummary` must include booleans for the visual contract:

```json
{
  "meshSurfaceVisible": true,
  "meshWireframeVisible": true,
  "scalarFieldVisible": true,
  "vectorGlyphsVisible": true,
  "regionOverlayVisible": true,
  "airboxVisible": true,
  "airboxFullVolumeWireframeVisible": true,
  "boundsOrDimensionFrameVisible": true,
  "orientationHudVisible": true,
  "selectionLayerAvailable": true,
  "productionDefaultsDisabledQuality": false
}
```

If a screenshot analysis cannot prove one of these fields automatically, the
script should record `unknown` with a reason. It must not record a false pass.

### 38.3 `suspect-report.md`

The report should be written for humans and agents. Required headings:

```markdown
# Viewport 3D Diagnostic Suspect Report

## Verdict
## Top Evidence
## Timeline Highlights
## Resource And Decode Costs
## Build Lane Costs
## GPU Upload Costs
## React And R3F Costs
## Interaction Responsiveness
## Idle Behavior
## Memory And Resource Ownership
## Visual Quality Gate
## Next Engineering Action
```

The `Verdict` must name one primary bucket. If two buckets are close, the report
must say that explicitly and list the next differentiating experiment.

### 38.4 `timeline.ndjson`

Every timeline record needs:

```ts
export interface ControlRoomTimelineRecord {
  readonly timestampMs: number;
  readonly source:
    | "browser"
    | "react"
    | "resource"
    | "viewport-3d"
    | "build-engine"
    | "worker"
    | "gpu-upload"
    | "diagnostics";
  readonly event: string;
  readonly correlationId: string | null;
  readonly scenarioId: string;
  readonly details: Record<string, unknown>;
}
```

Correlation ids should connect resource fetches, build jobs, upload tickets and
visible adoption where possible.

### 38.5 `viewport-3d-build.ndjson`

Every build record must include:

```ts
export interface Viewport3DBuildArtifactRecord {
  readonly timestampMs: number;
  readonly lane:
    | "binary-decode"
    | "topology-index"
    | "field-color"
    | "vector-glyph"
    | "region-overlay"
    | "mesh-quality"
    | "selection-picking"
    | "airbox-bounds";
  readonly key: string;
  readonly groupKey: string;
  readonly revisionSummary: string;
  readonly targetRevision: string | null;
  readonly visibleRevisionBefore: string | null;
  readonly visibleRevisionAfter: string | null;
  readonly staleState:
    | "none"
    | "stale-compatible"
    | "stale-physical"
    | "invalid-suppressed";
  readonly queueWaitMs: number;
  readonly workerComputeMs: number;
  readonly transferMs: number;
  readonly mainAdoptMs: number;
  readonly totalWallMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly itemCount: number;
  readonly aborted: boolean;
  readonly droppedBecauseObsolete: boolean;
  readonly fallbackReason: string | null;
}
```

### 38.6 `viewport-3d-upload.ndjson`

Every upload record must include:

```ts
export interface Viewport3DUploadArtifactRecord {
  readonly timestampMs: number;
  readonly ticketId: string;
  readonly lane: string;
  readonly key: string;
  readonly estimatedBytes: number;
  readonly uploadedBytes: number;
  readonly itemCount: number;
  readonly sliceCount: number;
  readonly maxSliceMs: number;
  readonly budgetMissCount: number;
  readonly abortedBeforeVisible: boolean;
  readonly visibleAdopted: boolean;
}
```

## 39. Implementation Slice Blueprint

Each slice should be small enough to review and large enough to improve the
real system. The immediate slice should look like this:

```markdown
### Slice: Field Color Worker And Upload Adoption

**Goal:** Field color updates are built through a dedicated worker wrapper and
adopted through the GPU upload manager without changing colormap/range output.
**Visual quality preserved:** scalar field colors, target scoping, color map,
color range, mesh surfaces, mesh wireframe, vector glyphs, region overlays,
airbox, bounds and HUD.
**Baseline:** current field-color model tests plus the next full CofeB
diagnostic artifact after integration.
**Files touched:** `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildWorker.ts`,
`apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildScheduler.ts`,
`apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.ts`,
`apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts`
where upload integration is required, and the tests beside those modules.
**Risk:** color semantics could drift or worker output could still freeze the
main thread during adoption/upload.

- [ ] Write failing unit/model test.
- [ ] Run targeted test and confirm failure.
- [ ] Implement smallest production change.
- [ ] Run targeted test and confirm pass.
- [ ] Run viewport module test subset.
- [ ] Run typecheck, lint and full tests.
- [ ] Run browser smoke for viewport work.
- [ ] Update diagnostic artifact or state why this slice is test-only.
- [ ] Update this tracker and the active build-engine tracker.
```

No slice may mix unrelated concerns. For example, field-color lane work must not
also restyle Tools UI, and region-overlay work must not alter camera controls.

## 40. Detailed Lane Acceptance Contracts

### 40.1 Binary Decode

Pass conditions:

- decode duration is measured separately from network transfer;
- stale decode result cannot update unmounted viewport state;
- worker fallback is bounded and recorded;
- large decoded arrays do not enter React state.

Failure conditions:

- decode happens synchronously during React render;
- decode failure is silently retried in a tight loop;
- artifact cannot tell whether the time was network or decode.

### 40.2 Topology Index

Pass conditions:

- key includes topology and mapping revisions;
- key excludes field revision, camera, hover and selection;
- topology handle is cacheable and ref-counted;
- field update produces topology cache hit.

Failure conditions:

- quantity switch rebuilds topology;
- camera pan schedules topology work;
- stale topology is shown as current.

### 40.3 Field Color

Pass conditions:

- color output matches existing colormap/range semantics;
- key includes topology, field, quantity, component, color range, target and sampling;
- backend stats are used when available;
- missing stats are computed off main thread;
- upload is chunked through the GPU upload manager.

Failure conditions:

- color range changes only because of optimization;
- colors are computed in a render path;
- full color buffer upload happens in one unbounded main-thread burst.

### 40.4 Vector Glyph

Pass conditions:

- glyph density, scale, color and target scoping match baseline;
- independent glyph jobs can use bounded concurrency;
- obsolete glyph results cannot become visible;
- matrix and color uploads are ticketed.

Failure conditions:

- glyphs disappear under production defaults;
- density is reduced without an explicit diagnostic profile;
- a stale field's glyphs are labeled current.

### 40.5 Region Overlay

Pass conditions:

- authored, realized, both and auto modes keep their semantics;
- realized overlay derivation is off main thread for large topology;
- fallback/degraded mapping is explicit;
- region overlay update does not rebuild field colors or topology unless the
  topology/region revision changed.

Failure conditions:

- region layer is hidden to pass performance;
- overlay mode mutates physics or canonical model state;
- incomplete backend mapping is presented as complete.

### 40.6 GPU Upload

Pass conditions:

- uploads are ticketed, chunked and abortable;
- visible mutation happens after ticket completion;
- budget misses are recorded;
- repeated budget misses adjust scheduling or fail the gate.

Failure conditions:

- worker result is adopted through one giant `BufferAttribute` replacement;
- `setMatrixAt` loops over large glyph sets in one frame;
- obsolete upload mutates visible buffers after a newer revision exists.

### 40.7 React/R3F Layer Cleanup

Pass conditions:

- layer render functions consume handles and small primitives;
- large typed arrays live in resource/cache/worker ownership, not React state;
- effects release upload tickets and cache refs;
- material/uniform-only changes avoid geometry rebuilds.

Failure conditions:

- broad `useMemo` allocates mesh-size arrays;
- component state holds large buffers;
- unmount leaves WebGL resources or workers alive.

## 41. Production SLOs And Budgets

Initial budgets are deliberately conservative. They can be tightened after the
first stable artifact series.

| Area | Budget | Enforcement |
|---|---:|---|
| Fullmag-owned single main-thread task during normal update | `< 100 ms` | diagnostic failure above threshold |
| Fullmag-owned repeated idle long tasks | `0` | idle audit failure |
| Idle viewport frames after settle | `0` | smoke/audit failure |
| GPU upload slice target | `<= 3 ms` | warning above target |
| GPU upload slice hard max | `<= 5 ms` repeated misses fail | upload artifact |
| Worker pool total | `<= 4` by default | scheduler tests |
| Vector glyph workers | `<= 2` by default | worker-pool tests |
| Topology/region workers | `<= 1` per lane | worker-pool tests |
| Diagnostic record memory | bounded with dropped counts | recorder tests |
| WebGL context after load | not lost | browser smoke |
| Drawing buffer after load | non-zero | browser smoke |
| Production quality disabling flags | none | source-level test |

The goal is not to make a `99 ms` task acceptable. The goal is to remove
multi-second Fullmag-owned stalls and keep normal interaction well below the
browser's long-task threshold.

## 42. Comparative Diagnostic Workflow

When diagnosing a freeze, use paired artifacts. A single artifact can identify a
suspect; paired artifacts prove improvement.

### 42.1 Baseline Capture

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

Record:

- artifact path;
- branch and commit;
- whether worktree is dirty;
- scenario id;
- max long task;
- max long animation frame;
- first full-quality ready time;
- top suspect bucket;
- final quality summary.

### 42.2 Controlled Experiment

Change one production owner only:

- one lane;
- one scheduler policy;
- one upload policy;
- one diagnostic parser;
- one lifecycle cleanup.

Do not change visual quality in the same experiment. Do not compare a full
quality baseline to a layer-disabled run except when explicitly isolating a
suspect.

### 42.3 Comparison Report

The comparison should answer:

```text
What changed?
Which artifact is baseline?
Which artifact is candidate?
Did visual quality remain full?
Did the top suspect bucket change?
Did max long task improve?
Did max LOAF improve?
Did interaction pan/orbit improve?
Did idle remain quiet?
Did memory/resource count remain bounded?
What is the next bottleneck?
```

If numbers improve but quality is reduced, the experiment is not a production
success.

## 43. Specific Known Current Failure Modes To Guard

The current work has already exposed several classes of failures. The plan must
guard them explicitly.

### 43.1 `useSyncExternalStore` Snapshot Churn

Failure:

- `getSnapshot` returns a fresh object every call;
- React detects unstable external-store snapshots;
- repeated re-render can hit maximum update depth.

Guard:

- snapshots are cached by store revision;
- tests assert stable reference when content does not change;
- Diagnostic Recorder UI uses compact derived snapshots, not raw mutable logs.

### 43.2 Worker Wall Time Misread As UI Freeze

Failure:

- a worker takes several seconds;
- artifact labels total wall time as main-thread blocking;
- wrong fix targets worker compute when freeze was upload/adoption or React.

Guard:

- queue, worker, transfer, adoption, upload and React commit have separate
  fields;
- suspect report names which phase blocked the main thread.

### 43.3 GPU Upload After Successful Worker Move

Failure:

- expensive compute moves to worker;
- result upload still happens in one giant main-thread operation;
- browser still freezes.

Guard:

- every large worker result enters upload manager;
- upload tickets record slices and budget misses;
- obsolete tickets abort before visible mutation.

### 43.4 Stale Visual Honesty

Failure:

- old field remains visible while current field builds;
- UI labels it ready/current;
- scientist trusts stale physical data.

Guard:

- visible and target revisions are always recorded;
- stale-physical state appears in diagnostics and compact UI;
- `full-quality current` requires visible key equals target key.

### 43.5 Diagnostic Tool Becomes The Bottleneck

Failure:

- recorder captures too many events;
- UI renders live raw logs;
- profiling changes the measured performance.

Guard:

- bounded records;
- dropped counts;
- summaries over raw rows in UI;
- export/report generation runs on explicit action or idle.

## 44. Professional Design Principles For This Work

These principles are the practical version of "how professional simulation
software does it".

1. Separate physical truth from visualization products.
2. Make every derived visualization product addressable by semantic key.
3. Keep UI input higher priority than postprocessing.
4. Keep the previous safe visible state while current data builds.
5. Never present stale physical data as current.
6. Move compute off main thread, but still budget transfer and GPU upload.
7. Cache immutable derived products; release them deterministically.
8. Prefer bounded throughput over unbounded parallelism.
9. Measure every phase before optimizing it.
10. Preserve final visual quality unless the user explicitly chooses a
    diagnostic profile.
11. Keep browser and future server-derived resources semantically equivalent.
12. Treat diagnostics as a product feature with its own performance budget.

## 45. Final Self-Review After Expansion

I reviewed the expanded plan against the original problem statement and the v2
frontend specs.

Checks passed:

- The plan preserves one domain-neutral 3D viewport and does not fork FDM/FEM.
- The plan separates topology, field, visualization state, camera, selection
  and GPU upload.
- The plan refuses quality reduction as a production optimization.
- The plan explains how to capture logs from boot without manual clicking.
- The plan makes the diagnostic artifact sufficient for future agent debugging.
- The plan handles memory/resource lifecycle, not only CPU time.
- The plan includes rollback rules that preserve visual quality.
- The plan leaves future server-derived resources behind a spec/API gate rather
  than inventing false backend details now.

Remaining unknowns are empirical, not strategic:

- the exact post-fix dominant lane;
- exact final timings on this machine/browser/GPU;
- whether large future cases require server-derived resources earlier than
  expected.

Those unknowns are intentionally resolved by artifacts, not by speculation.

Final judgement: this is the strongest production strategy for the current
problem because it upgrades the viewport from ad hoc component work into a
measured, bounded, cancellable and full-quality scientific visualization
pipeline.

## 46. Fourth-Pass Red-Team Review

I reviewed the plan again from the position of a skeptical production reviewer.
The strongest possible implementation still has several loopholes if we do not
close them explicitly.

### 46.1 Loophole: Worker Compute Moves But Transfer Still Freezes UI

Risk:

- a worker produces a large buffer correctly;
- the result is transferred or cloned inefficiently;
- main thread then blocks on adoption/upload;
- the report incorrectly says "worker solved" while UI still freezes.

Required fix:

- every large worker result uses transferables where ownership can move safely;
- every transferred buffer records `inputBytes`, `outputBytes`,
  `transferMs`, `mainAdoptMs` and `mainUploadMs`;
- every lane has a source-level test that large results enter the GPU upload
  manager before visible adoption;
- obsolete results must be dropped before material, geometry or attribute
  mutation.

### 46.2 Loophole: Too Many Workers Starve Input

Risk:

- worker count is technically bounded but still too high for the machine;
- pan/orbit/zoom feel bad because CPU is saturated;
- the fix is mistaken for a rendering problem.

Required fix:

- `maxTotalWorkers` remains conservative;
- hardware concurrency can lower limits, not raise them above tested defaults;
- input latency during camera gestures is recorded while lanes are busy;
- repeated input delay forces lower concurrency before any quality reduction is
  considered.

### 46.3 Loophole: Cache Improves Speed But Leaks Memory

Risk:

- derived buffers remain retained after quantity switches and tab changes;
- repeated workflow consumes memory until browser slows down or loses context;
- one diagnostic run looks good, long session fails.

Required fix:

- cache entries are retained only through explicit handles;
- every handle has a release trigger;
- memory stress loops are required before calling the lane production-ready;
- cache bytes, handle counts and WebGL counts are compared before and after
  `viewport-3d -> cross-section-image -> analysis-plots -> viewport-3d`.

### 46.4 Loophole: Stale Visuals Are Fast But Scientifically Dangerous

Risk:

- old field colors or glyphs remain visible during rebuild;
- UI labels the viewport as current;
- the scientist interprets stale physics as current data.

Required fix:

- visible key and target key are recorded for each lane;
- stale physical state appears in the diagnostic artifact and compact viewport
  status;
- `full-quality-current` requires all required visible keys to match target
  keys;
- stale physical presentation is allowed only as a temporary responsiveness
  strategy, never as a silent final state.

### 46.5 Loophole: Diagnostic Recorder Becomes The Freeze

Risk:

- the recorder captures every event in live React state;
- Tools UI renders raw timeline rows;
- profiling overhead changes the system being measured.

Required fix:

- raw diagnostic streams are append-only bounded buffers outside React render
  trees;
- UI receives compact cached snapshots through stable external-store snapshots;
- detail records have dropped-count summaries when limits are reached;
- export/report generation runs by explicit action or idle task, not during
  pointer interaction or render.

### 46.6 Loophole: Dev-Mode Noise Is Confused With Product Cost

Risk:

- Next.js dev server, HMR, React development checks, source-map frames and
  browser extensions add noise;
- we optimize the wrong path or dismiss a real issue as dev noise.

Required fix:

- every artifact records mode: `next-dev`, `production-build`, `browser-smoke`
  or `diagnostic-dev`;
- HMR, source-map stack frame requests and React dev warnings are grouped as
  environment overhead;
- production validation must include a build/serve style run once the code path
  is stable enough;
- dev-mode artifacts are still useful for attribution, but not for final SLO
  acceptance.

### 46.7 Loophole: External Font/Text Pipeline Blocks Startup

Risk:

- HUD/text rendering triggers external font metadata or font file requests;
- a CDN path, text atlas generation or font resolver stalls startup;
- the issue is incorrectly attributed to mesh/vector layers.

Required fix:

- diagnostic artifact groups text/font/atlas work separately from geometry and
  field lanes;
- production viewport HUD uses local packaged fonts or explicit app-owned font
  assets, not surprise CDN fetches during first 3D ready;
- text atlas generation is measured and cached by font/style/text revision;
- HUD remains enabled, but its assets are controlled and observable.

### 46.8 Loophole: Shader/Material Compile Cost Appears As Random Frame Stall

Risk:

- workers and uploads are optimized;
- first material/shader use still compiles in a visible frame;
- the freeze appears in R3F/browser time rather than build time.

Required fix:

- material creation and first-use compile windows are recorded as presentation
  diagnostics;
- known heavy materials are created deterministically when resources become
  ready, not lazily during a camera interaction;
- if shader warmup is added, it must be bounded and cannot mount duplicate
  visible layers or extra canvases.

## 47. Release Gate Board

This plan should be executed as a sequence of release gates. A gate can pass
only with artifacts, not subjective impressions.

| Gate | Name | Required proof | Blocks release if |
|---|---|---|---|
| G0 | Baseline exists | current CofeB artifact with full 3D and suspect report | no comparable baseline artifact |
| G1 | Attribution complete | summary separates fetch, decode, worker, transfer, adoption, upload, React, R3F and diagnostics | top freeze bucket is `unknown` |
| G2 | Scheduler bounded | tests prove max workers, queue limits, aborts and disposal | any lane can grow unbounded |
| G3 | Full-quality defaults | source test and screenshot prove required layers are enabled | a production default disables quality |
| G4 | Upload budgeted | upload records show slices, bytes and budget misses | large worker result adopts in one unbounded frame |
| G5 | Interaction measured | pan/orbit/zoom metrics under build/upload load | pan remains unexplained or dominated by Fullmag-owned work |
| G6 | Idle quiet | zero idle viewport frames and no repeated idle long tasks | demand rendering keeps firing without dirty reason |
| G7 | Memory bounded | stress loop returns workers/cache/WebGL/listeners near baseline | repeated workflow grows without release |
| G8 | Browser smoke | canvas visible, context not lost, drawing buffer non-zero | viewport can pass unit tests while WebGL is broken |
| G9 | Production artifact | final CofeB artifact shows no Fullmag-owned multi-second stall | multi-second stall remains without a next classified action |

Minimum merge bar for any viewport performance slice:

- targeted tests for the changed owner;
- `pnpm --dir apps/control-room typecheck`;
- `pnpm --dir apps/control-room lint`;
- `pnpm --dir apps/control-room test`;
- `git diff --check`;
- browser smoke when WebGL/viewport lifecycle is touched;
- plan tracker updated with what was proven.

## 48. Observability Cardinality And Overhead Limits

The diagnostic system must be rich enough for forensics and small enough not to
become the workload.

### 48.1 Record Classes

| Class | Examples | Retention policy |
|---|---|---|
| summary | top suspects, max timings, quality booleans | always kept |
| phase | resource, build, upload, interaction windows | kept for whole capture |
| detail | individual dirty frames, worker state transitions | bounded ring with dropped count |
| verbose | console stacks, raw traces, source maps | profile-gated or exported separately |
| screenshot | boot, first ready, gestures, idle | fixed scenario list |

### 48.2 Required Dropped-Count Semantics

If a buffer reaches its cap, the recorder must preserve:

- first timestamp dropped;
- last timestamp dropped;
- number of dropped records;
- record class;
- source;
- reason.

It must not silently discard diagnostic information.

### 48.3 Correlation Ids

Every expensive path should carry a correlation id:

```text
resource request
  -> binary decode
  -> render-model dependency
  -> build job
  -> worker result
  -> upload ticket
  -> visible adoption
  -> dirty frame
```

This is what lets an agent inspect one artifact and trace the freeze without a
live browser.

## 49. Production Mode Matrix

The viewport needs explicit modes so diagnostic tools, rollout flags and normal
product behavior do not blur together.

| Mode | Purpose | Quality | Diagnostics | Allowed overhead |
|---|---|---|---|---|
| `production` | normal product path | full | summaries and bounded health records | minimal |
| `diagnostic` | reproduce freezes and export artifacts | full unless user selects isolation | detailed bounded records | moderate, measured |
| `layer-isolation` | identify one suspect layer | intentionally incomplete | explicit degraded/isolation marker | moderate |
| `stress` | memory and lifecycle validation | full unless scenario says otherwise | detailed resource ledger | high but scripted |
| `comparison` | old/new lane comparison | full for production claims | paired artifacts | moderate |

Rules:

- only `diagnostic` and `layer-isolation` may disable a visual layer;
- `production` defaults must not depend on local developer flags;
- every artifact records the mode;
- performance wins from `layer-isolation` are evidence for diagnosis, not
  evidence of product success.

## 50. Data Contract For Future Server-Derived Resources

Server-derived resources are intentionally not the first step, but the browser
architecture must leave a clean boundary for them.

Required common fields:

```ts
export interface Viewport3DDerivedResourceEnvelope {
  readonly schemaVersion: 1;
  readonly buildKey: string;
  readonly lane:
    | "topology-index"
    | "field-color"
    | "vector-glyph"
    | "region-overlay"
    | "mesh-quality";
  readonly origin: "browser-worker" | "server-derived";
  readonly algorithmVersion: number;
  readonly sourceRevisions: {
    readonly topologyRevision: string | null;
    readonly fieldRevision: string | null;
    readonly targetVisualizationRevision: string;
    readonly styleRevision: string;
    readonly samplingRevision: string;
  };
  readonly byteLength: number;
  readonly itemCount: number;
  readonly qualityContract: "full" | "diagnostic-degraded";
}
```

Equivalence requirement:

- the same build key must mean the same visible semantics regardless of origin;
- browser and server outputs may differ in binary packing, but not in scientific
  meaning, layer coverage, colormap/range semantics or glyph sampling policy;
- a server-derived path must fall back to browser-worker path without changing
  user-visible semantics.

## 51. Concrete First Execution Slices After This Master Plan

This master plan should not be implemented as one huge patch. The next slices
should be:

1. finish the current field-color lane by adding the dedicated worker wrapper,
   semantic range/stat keys and upload-manager adoption;
2. add GPU upload tickets to vector glyph matrix/color adoption if any direct
   large upload remains;
3. harden the CofeB diagnostic script so every run writes `suspect-report.md`
   and quality booleans;
4. run the full CofeB artifact and classify the remaining top freeze bucket;
5. implement the next dominant lane only after the artifact identifies it;
6. add memory stress for 3D -> non-3D -> 3D and repeated quantity switches;
7. add the runbook once the workflow is stable enough that another agent can
   reproduce it from commands alone.

This order keeps momentum while preventing speculative rewrites.

## 52. Final Professional Decision

After the additional red-team pass, the decision remains the same:

- do not trade visual quality for speed;
- do not patch individual symptoms in R3F layers;
- build a production visualization pipeline with stable keys, bounded workers,
  derived-buffer ownership, chunked GPU upload, explicit stale state and
  boot-start diagnostics.

The plan is professionally strong because it is not based on a single trick.
It closes the complete path from canonical resource to visible frame and from
visible frame back to diagnostic evidence.

The only claims intentionally deferred are numerical performance claims. Those
must come from the CofeB artifact after each slice. That is the correct
engineering standard for this problem.

## 53. Production Operating Model

This work should be run like a production visualization subsystem, not like a
single frontend bugfix. The important organization is ownership.

### 53.1 Runtime Owners

| Area | Primary owner in code | Production responsibility |
|---|---|---|
| canonical resource truth | v2 API facade and resource hooks | fetch revisions and payloads without UI-specific semantics |
| semantic render model | `useViewport3DSceneModel.ts`, `viewport3dRenderModel.ts` | describe what should be visible using small stable references |
| derived build engine | `viewport-3d/build-engine/*` | schedule, cancel, cache and diagnose expensive derived work |
| worker lanes | lane-specific worker/model/scheduler files | compute expensive buffers away from React and R3F |
| GPU upload | `viewport-3d/build-engine/gpu/*` | adopt large buffers without unbounded frame stalls |
| R3F presentation | `viewport-3d/layers/*` | own Three.js resources and render only visible handles |
| diagnostics | diagnostic recorder and viewport diagnostics | produce bounded, correlated forensic artifacts |
| quality gates | tests, smoke scripts and CofeB diagnostic recipe | prevent regressions and false performance claims |

No unit should own two adjacent layers unless the boundary is intentionally
temporary and the plan says when it will be split.

### 53.2 Professional Review Rhythm

Every implementation slice must pass through this sequence:

1. Define the scenario and the exact visual quality that must remain.
2. Capture or identify the baseline evidence.
3. Write the failing test or diagnostic assertion first.
4. Implement the smallest production change for one owner.
5. Run targeted tests for the changed owner.
6. Run the viewport subset affected by that owner.
7. Run typecheck, lint, full tests and `git diff --check`.
8. Run browser smoke for any viewport/WebGL lifecycle change.
9. Run CofeB diagnostic only when the slice is expected to affect real
   startup/update timings.
10. Update the active tracker with what was proven and what remains unknown.

Skipping the baseline is allowed only for pure documentation or pure test
cleanup. Skipping visual proof is not allowed for viewport behavior changes.

### 53.3 Artifact-First Decision Making

The next engineering action is chosen from artifacts, not from intuition.

| Artifact says | Next action |
|---|---|
| queue wait dominates | reduce queue contention, dedupe keys, abort obsolete groups |
| worker compute dominates | optimize lane model, add browser/server split only after key contract is stable |
| transfer dominates | use transferables, reduce cloning, split payloads by lane |
| main adoption dominates | move adoption into upload tickets and chunk visible mutation |
| GPU upload dominates | lower slice budget, pre-create resources, avoid one-frame attribute replacement |
| React commit dominates | stabilize external-store snapshots and component deps |
| R3F frame dominates | inspect object/material counts, shader compile and layer ownership |
| idle frames dominate | remove dirty-loop source and prove no continuous frameloop |
| memory grows | fix retain/release before adding more caching |
| diagnostics dominate | reduce recorder verbosity and keep summary records only |

The plan is successful when this table becomes operational: the artifact tells
us which row we are in.

## 54. Exact Execution Protocol For Each Slice

Use this protocol even when the change looks small.

### 54.1 Pre-Slice Checklist

- [ ] Read the current active tracker.
- [ ] Identify exactly one owner: diagnostics, scheduler, cache, upload, one
  lane, one layer group, or one smoke/audit script.
- [ ] State whether the slice can change visible output. The default answer is
  no.
- [ ] Identify the baseline test or artifact.
- [ ] Identify the command that must fail before implementation.
- [ ] Identify the browser smoke or diagnostic scenario required after
  implementation.

### 54.2 RED Step

For a code slice, add one of these first:

- a unit test proving key stability, cancellation, cache release or upload
  chunking;
- a model test proving visual semantics are unchanged;
- a script test proving the artifact contains the required field;
- a browser smoke assertion proving canvas, context, layer presence or idle
  quietness.

The RED output must be read. If the test passes before implementation, the test
does not protect the change and must be corrected.

### 54.3 GREEN Step

The implementation should change the smallest set of files required for the
owner. It must not include unrelated styling, unrelated API changes or broad
formatting.

For lane work, the expected shape is:

```text
pure build model
  -> worker wrapper
  -> scheduler/build-engine key
  -> cache handle
  -> upload ticket if large WebGL mutation is required
  -> layer consumes handle
  -> diagnostics record
```

For diagnostic work, the expected shape is:

```text
record type
  -> bounded collector
  -> summary reducer
  -> artifact writer
  -> suspect report section
  -> UI summary only if useful
```

### 54.4 Verification Step

Minimum commands for viewport slices:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
git diff --check
```

Add browser smoke whenever WebGL lifecycle, R3F layers, GPU upload, worker
adoption or viewport diagnostics changed:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Add the real diagnostic gate when the slice claims to affect the freeze:

```bash
just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d
```

### 54.5 Completion Note

Every slice completion note must include:

- changed owner;
- visual quality preserved;
- tests run;
- browser smoke result when applicable;
- artifact path when a performance claim is made;
- remaining dominant suspect, if known;
- tracker checkbox updated.

## 55. First Three Execution Slices Expanded

These are the most important near-term slices because they directly answer the
current freeze investigation without reducing visual quality.

### 55.1 Slice A: Field Color Lane Uses Backend Stats When Present

Goal:

- avoid scanning large fields for scalar range when the backend already
  publishes stats;
- compute missing stats in worker;
- preserve colormap and color-range semantics.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dColorTransformScheduler.ts`
- Modify if existing resource path supports it: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.test.ts`

RED tests:

- provided `scalarRange` is used instead of scanning values;
- invalid non-finite range is ignored and worker/model computes range;
- field-color key changes when range revision changes;
- camera-only state does not change field-color key.

Acceptance:

- backend-provided stats are used when available;
- missing stats still produce correct colors;
- no field color path stores large arrays in React state;
- color output remains semantically identical for the same range/palette/input.

### 55.2 Slice B: GPU Upload Tickets For Large Color And Glyph Buffers

Goal:

- prevent worker success from becoming a main-thread upload freeze.

Files:

- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify as needed: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.test.ts`

RED tests:

- upload manager splits a large upload into multiple budgeted slices;
- abort before visible mutation prevents stale buffer adoption;
- obsolete upload cannot mark a newer key visible;
- diagnostics record slice count, max slice time and budget misses.

Acceptance:

- large color/glyph buffers are not adopted through one unbounded frame;
- visible mutation is atomic after upload completion;
- final screenshot still shows full field colors and glyphs.

### 55.3 Slice C: CofeB Full 3D Diagnostic Comparison Gate

Goal:

- make one command produce a complete artifact that explains the freeze.

Files:

- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Modify: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticSuspectReport.ts`
- Modify: `justfile` only if the existing recipe cannot express the scenario.
- Test: `apps/control-room/src/kernel/performance/diagnosticRecorderScript.test.ts`

RED tests:

- recorder script writes `suspect-report.md`;
- summary includes `qualitySummary`;
- summary includes build/upload lane buckets;
- report names `unknown` only when required streams are missing, and then lists
  the missing streams.

Acceptance:

- `just run-cofeb-rings-relax-diagnostics gpu auto 3194 viewport-3d` writes a
  browser artifact path;
- artifact includes screenshots, summary and suspect report;
- quality summary does not falsely pass unknown screenshot/layer evidence;
- the next engineering action can be selected from the report.

## 56. CAE-Class User Experience Contract

The user experience should resemble a professional simulation postprocessor:
rich visualization remains available, but expensive work is transparent and
controlled.

### 56.1 Startup

On boot, the viewport may progress through visible readiness states:

```text
workspace ready
  -> viewport resources loading
  -> topology ready
  -> building field colors
  -> building glyphs
  -> uploading derived buffers
  -> full quality current
```

The user should be able to move the camera as soon as a safe visible scene
exists. This does not mean hiding the final layers. It means presenting partial
readiness honestly while full-quality derived buffers complete.

### 56.2 Updates

During a field update:

- old current topology may remain;
- old field colors/glyphs may remain only as `stale-physical`;
- UI and artifact must say target revision differs from visible revision;
- final state must become `full quality current`.

During a style update:

- old physical data may remain as `stale-compatible`;
- material/uniform updates should avoid topology rebuild;
- output quality must match the selected style after rebuild.

### 56.3 Interaction

Camera controls are P0 work. Heavy visualization work must not prevent:

- pan;
- orbit;
- zoom;
- menu commands;
- export/cancel actions.

If camera control itself is slow after all Fullmag-owned work is bounded, the
artifact must say that the remaining cost is browser/R3F/control-level rather
than resource/build/upload-level.

## 57. Critical Non-Code Decisions

These decisions should not be reopened casually.

1. Keep one R3F canvas for the 3D viewport.
2. Keep FDM/FEM unified through domain-neutral render models.
3. Keep full-quality visualization as the production default.
4. Keep diagnostic layer disabling out of production defaults.
5. Keep server-derived resources behind the same build-key contract.
6. Keep upload/adoption separate from worker compute.
7. Keep diagnostic recorder bounded and boot-started.
8. Keep stale physical data explicit.
9. Keep performance claims artifact-based.
10. Keep memory stress as a release gate, not an optional cleanup task.

Changing any of these requires updating this plan and the relevant frontend v2
spec before code changes.

## 58. Future Agent Audit Checklist

Before touching viewport performance code, an agent should answer these:

- Which lane or owner am I changing?
- What exact visual quality must remain?
- Which key fields identify the derived result?
- Which resource revision changes should rebuild it?
- Which changes must not rebuild it?
- Can stale previous output remain visible?
- If yes, is it stale-compatible or stale-physical?
- Where does worker compute end and main-thread adoption begin?
- Where does GPU upload happen?
- Who owns the memory and who releases it?
- Which diagnostic record proves the behavior?
- Which test fails before the change?
- Which artifact proves the real freeze improved?

If any answer is missing, the slice is not ready.

## 59. Fifth-Pass Professional Review

I reviewed the plan one more time after adding the operating model. The
strongest remaining failure mode would be treating this master plan as a license
for a huge refactor. The answer is the opposite: the plan is broad so that each
slice can be narrow and correctly placed.

The plan now has:

- product contract;
- architecture;
- lane model;
- state machines;
- diagnostics;
- memory ownership;
- rollout gates;
- rollback rules;
- exact near-term slices;
- future server-derived boundary;
- agent audit checklist.

The only honest uncertainty left is empirical timing. That cannot be solved in
the document. It must be solved by the CofeB artifacts after each slice.

Final professional decision after five passes:

```text
Do not reduce quality.
Do not guess.
Instrument from boot.
Separate compute, transfer, adoption and upload.
Keep interaction priority above postprocessing.
Cache and release explicitly.
Let the artifact choose the next bottleneck.
```

## 60. Sixth-Pass Review After Final Expansion

I re-read the complete plan again with the specific production question in
mind: would this be acceptable as the operating plan for a professional
simulation viewport where users expect COMSOL-class reliability and visual
quality?

The answer is yes, with one important discipline: implementation must remain
slice-based and evidence-gated. The plan is broad enough to cover the whole
system, but each code change must still be narrow enough to verify.

What this final pass confirms:

- quality is protected as a first-class requirement, not an afterthought;
- the architecture fixes the real ownership problem instead of hiding layers;
- the main thread is reserved for interaction, small state, adoption and draw
  submission;
- heavy work is assigned to bounded workers or future server-derived resources;
- GPU upload is treated as a separate bottleneck from worker compute;
- stale visual state is explicit, so the user is not misled scientifically;
- diagnostics begin at boot and produce one shareable artifact;
- memory, workers, WebGL resources and object URLs have release expectations;
- every performance claim requires before/after evidence from the same
  scenario;
- future server-derived resources cannot fork visualization semantics because
  they must use the same build-key contract and equivalence tests.

What remains intentionally empirical:

- exact freeze duration after each slice;
- exact worker/upload balance on the CofeB case;
- whether the next dominant bucket is field colors, glyph upload, topology,
  region overlay, React commit, R3F frame time or browser/driver behavior.

This uncertainty is not a weakness in the plan. It is the reason the diagnostic
artifact exists. A professional plan for this class of problem should not
pretend to know timing numbers before measuring them.

Final acceptance of the strategy:

```text
This is the correct production direction for Fullmag:
full-fidelity visualization, bounded asynchronous preparation,
frame-budgeted presentation, explicit stale state, forensic diagnostics,
and artifact-driven optimization.
```
