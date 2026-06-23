# Fullmag Diagnostic Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade diagnostic recorder for `apps/control-room` so we can launch the GUI in a browser, record a complete observer log, export one forensic artifact, and use that artifact to fix startup freezes, 3D viewport stalls, render churn, request storms, and memory leaks without guessing.

**Architecture:** Implement a frontend-first black-box recorder with two capture layers: an in-page recorder that starts before React through `instrumentation-client.ts`, and a Playwright/CDP harness that launches Chromium, drives repeatable scenarios, captures browser metrics, and writes durable diagnostic artifacts. The recorder extends existing Fullmag diagnostics (`RequestDiagnosticsController`, `MemoryBudgetRegistry`, `ThreadManagerDialog`, viewport 3D resource tracker, performance audit scripts) instead of creating a parallel diagnostics stack.

**Tech Stack:** Next.js 16.2.6 app router, React 19, TypeScript, Vitest, Playwright/Chromium CDP, Three.js/R3F, existing Fullmag v2 resource-first API facade, existing `apps/control-room/src/design/styles/*` token CSS.

---

## Scope Decision

This plan targets a **frontend-first production diagnostic recorder**.

It must support the workflow the user asked for:

1. Start the Control Room dev server.
2. Launch a browser through a recorder command.
3. Exercise startup, 3D viewport load, quantity switches, center-surface switches, and idle windows.
4. Export a complete artifact.
5. Analyze the artifact with Codex and fix the frontend from evidence.

Backend persistence is deliberately deferred. A future `/v2/sessions/current/diagnostics/client-recordings` resource may be added after the recorder proves useful, but the first implementation must not block on OpenAPI/backend changes.

## Existing Context To Reuse

Current branch: `salvage/mixed-fem-viewport-35232294`.

Existing assets:

- `apps/control-room/instrumentation-client.ts` does not exist yet, but local Next 16.2.6 supports a project-root client instrumentation hook through `require-instrumentation-client`.
- `apps/control-room/src/kernel/api/RequestDiagnosticsController.ts` already stores bounded HTTP/WS/performance records.
- `apps/control-room/src/kernel/performance/browserActivityDiagnostics.ts` already records `longtask` and `long-animation-frame`, but only after `KernelProvider` and only behind runtime config.
- `apps/control-room/src/kernel/performance/performanceMeasureDiagnostics.ts` already exports `fullmag.*` `Performance.measure` entries.
- `apps/control-room/src/kernel/performance/MemoryBudgetRegistry.ts` already supports provider snapshots.
- `apps/control-room/src/kernel/layout/ThreadManagerDialog.tsx` already displays measured work, memory budgets, workers, and copyable logs.
- `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts` already tracks 3D resource counts and dirty frames.
- `apps/control-room/src/modules/viewport-3d/layers/CanvasLifecycleProbe.tsx` already records viewport frame-window diagnostics.
- `apps/control-room/scripts/smoke-viewport-3d.mjs` and `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs` already show the local Playwright style to reuse.

Current constraints:

- Browser JavaScript cannot read true OS CPU usage. The recorder must label CPU data as browser-load proxies: long tasks, long animation frames, event-loop lag, frame budget misses, measured synchronous work, worker activity, and CDP `Performance.getMetrics` where available.
- WebGL GPU memory is not directly available from Web APIs. The recorder must track resource ownership and estimated bytes by geometry/material/texture/render-target class.
- `apps/control-room/app/layout.test.tsx` intentionally blocks inline scripts, `next/script`, `beforeInteractive`, `dangerouslySetInnerHTML`, and inline `window.__FULLMAG_CONFIG__` in `layout.tsx`. Keep that safety rule.
- Idle behavior is a product contract: after settling, 3D frames must be zero unless there is a dirty reason.
- The recorder itself must not become the performance problem: no `setInterval` in app code, no unbounded logs, no large payloads in React state.

## Operator Workflow

The delivered tool must make this workflow possible:

```bash
pnpm --dir apps/control-room dev:binary
CONTROL_ROOM_URL=http://localhost:3100/workspace \
  pnpm --dir apps/control-room diagnostics:record
```

Default `diagnostics:record` behavior:

1. Launch Chromium with Playwright.
2. Install browser init config:
   - `enableDiagnosticRecorder: true`;
   - `diagnosticRecorderProfile: "forensic"`;
   - optional API base from `CONTROL_ROOM_API_BASE_URL`.
3. Navigate to `/workspace?diagnostics=record`.
4. Wait for the pre-React recorder global.
5. Wait for kernel recorder takeover.
6. Run the selected scenario.
7. Export one artifact directory under `apps/control-room/artifacts/diagnostics/<timestamp>-<scenario>/`.
8. Print the artifact path and a short suspect summary.

Interactive recording mode:

```bash
CONTROL_ROOM_DIAGNOSTICS_INTERACTIVE=1 \
CONTROL_ROOM_URL=http://localhost:3100/workspace \
  pnpm --dir apps/control-room diagnostics:record
```

Interactive behavior:

1. Launch headed Chromium.
2. Start recording before page load.
3. Show the in-app Diagnostic Recorder panel.
4. Let the user reproduce the bug manually.
5. Stop when the user presses Enter in the terminal or clicks Export in the UI.
6. Write the same artifact format as the scripted scenarios.

## Diagnostic Artifact Contract

The recorder writes both a single browser-downloadable JSON artifact and a Playwright-created directory artifact.

Directory artifact:

```text
apps/control-room/artifacts/diagnostics/<timestamp>-<scenario>/
  manifest.json
  summary.json
  suspect-report.md
  timeline.ndjson
  performance.ndjson
  requests.ndjson
  resources.ndjson
  memory.ndjson
  viewport-3d.ndjson
  console.ndjson
  react.ndjson
  browser-metrics.ndjson
  chromium-trace.json
  screenshots/
    000-start.png
    010-first-viewport.png
    020-after-scenario.png
```

Single UI-export artifact:

```text
fullmag-diagnostics-<timestamp>-<scenario>.json
```

The single JSON contains the same logical streams, but omits large screenshots and the raw Chromium trace.

Artifact rules:

- Do not record full binary field/topology payloads.
- Do not record response bodies by default.
- Record request method, path, query, status, duration, content type, byte length, ETag, `x-request-id`, and resource key.
- Redact tokens, cookies, authorization headers, and arbitrary request bodies.
- Record dropped-event counts whenever the recorder applies backpressure.
- Include source build metadata: branch, commit hash if available, package version, Next/React/Three/R3F versions, browser version, viewport size, feature flags, and scenario name.

Minimal artifact schema:

```ts
export interface DiagnosticArtifactV1 {
  artifactVersion: 1;
  manifest: DiagnosticManifest;
  summary: DiagnosticSummary;
  streams: {
    timeline: DiagnosticRecord[];
    performance: DiagnosticRecord[];
    requests: DiagnosticRequestRecord[];
    resources: DiagnosticResourceRecord[];
    memory: DiagnosticMemoryRecord[];
    viewport3d: DiagnosticViewport3DRecord[];
    console: DiagnosticConsoleRecord[];
    react: DiagnosticReactRecord[];
    browserMetrics: DiagnosticBrowserMetricRecord[];
  };
  suspectReport: DiagnosticSuspectReport;
}
```

## Recording Profiles

Profiles are explicit and visible in the artifact.

| Profile | Default | Purpose | Capture Window | Buffer Policy |
|---|---:|---|---|---|
| `boot` | yes | catch startup freeze before React | first 120 seconds or `workspace.settled + 5s` | small ring, critical events never dropped |
| `session` | no | manual recording while user reproduces a bug | until user stops | bounded by max bytes |
| `viewport-3d` | no | diagnose WebGL/R3F/render-model costs | scenario duration | preserve all 3D lifecycle records |
| `memory-leak` | no | compare snapshots across repeated mount/unmount and quantity switch loops | scenario duration | keep snapshots and deltas |
| `forensic` | script default | broad capture for Codex analysis | scenario duration | large bounded buffers plus CDP trace |

In app code, profiles must be event-driven. The Playwright harness may poll page state from Node because it is outside the app runtime.

## Suspect Report Requirements

Every exported artifact must contain a generated suspect report that answers:

- What was the slowest startup phase?
- Did any main-thread task exceed 100 ms?
- Did long animation frames cluster around 3D topology, color mapping, vector glyphs, React rendering, or API decode?
- Did requests happen while the app was idle?
- Did resource-hook refetches happen for unrelated revisions?
- Did 3D render frames happen without dirty reasons?
- Did WebGL resources, workers, object URLs, typed arrays, or resource-cache bytes grow after a stress loop?
- Did unmounting `viewport-3d` return module-owned resource counts to zero?
- Did console/page errors happen before the first usable viewport?
- Which files/functions are named by `Performance.measure`, long-animation-frame script attribution, or Fullmag-specific marks?

The report should be deterministic text so Codex can read it directly without opening the UI.

## File Responsibility Map

Create:

```text
apps/control-room/instrumentation-client.ts
apps/control-room/scripts/record-diagnostics.mjs
apps/control-room/scripts/audit-diagnostic-recorder.mjs
apps/control-room/scripts/audit-diagnostic-memory-leak.mjs
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/earlyDiagnosticRecorder.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticRecorderConfig.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticArtifactExport.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticSuspectReport.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticLeakDetector.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticConsoleCapture.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticBrowserSnapshot.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/useDiagnosticRecorderSnapshot.ts
apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderDialog.tsx
apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderTimeline.tsx
apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderMemoryPanel.tsx
apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderViewport3DPanel.tsx
apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderExportPanel.tsx
apps/control-room/src/modules/footer/DiagnosticRecorderFooterPanel.tsx
apps/control-room/src/design/styles/diagnostic-recorder.css
```

Add tests:

```text
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/earlyDiagnosticRecorder.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticConsoleCapture.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticBrowserSnapshot.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticArtifactExport.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticSuspectReport.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticLeakDetector.test.ts
apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticScenarioModel.test.ts
apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderDialog.test.tsx
apps/control-room/src/modules/footer/DiagnosticRecorderFooterPanel.test.tsx
apps/control-room/src/kernel/performance/diagnosticRecorderScript.test.ts
apps/control-room/src/kernel/performance/diagnosticRecorderAuditScript.test.ts
```

Modify:

```text
apps/control-room/package.json
apps/control-room/app/layout.test.tsx
apps/control-room/app/globals.css
apps/control-room/src/design/styles/designStyles.test.ts
apps/control-room/src/kernel/types.ts
apps/control-room/src/kernel/KernelProvider.tsx
apps/control-room/src/kernel/KernelProvider.test.ts
apps/control-room/src/kernel/browserFullmagConfig.ts
apps/control-room/src/kernel/api/RequestDiagnosticsController.ts
apps/control-room/src/kernel/api/ControlRoomApi.ts
apps/control-room/src/kernel/api/binaryDecodeScheduler.ts
apps/control-room/src/kernel/resources/ResourceCache.ts
apps/control-room/src/kernel/resources/useResource.ts
apps/control-room/src/kernel/performance/MemoryBudgetRegistry.ts
apps/control-room/src/kernel/performance/threadManagerModel.ts
apps/control-room/src/kernel/performance/browserActivityDiagnostics.ts
apps/control-room/src/kernel/performance/performanceMeasureDiagnostics.ts
apps/control-room/src/kernel/layout/AppMenuBar.tsx
apps/control-room/src/kernel/layout/appMenuModel.tsx
apps/control-room/src/kernel/layout/AppMenuBar.test.ts
apps/control-room/src/kernel/events/eventTypes.ts
apps/control-room/src/modules/footer/FooterModule.tsx
apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts
apps/control-room/src/modules/viewport-3d/layers/CanvasLifecycleProbe.tsx
apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts
apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx
apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx
apps/control-room/src/modules/viewport-3d/viewport-memory-stress.test.ts
docs/specs/frontend-v2/17-performance-memory-profiler.md
```

Do not modify generated OpenAPI files in the first pass.

## Implementation Tasks

### Task 1: Lock Baseline And Existing Contracts

**Files:**
- Read: `docs/specs/frontend-v2/17-performance-memory-profiler.md`
- Read: `docs/specs/frontend-v2/05-viewport-architecture.md`
- Read: `docs/specs/frontend-v2/14-viewport-3d-module.md`
- Read: `docs/specs/frontend-v2/15-viewport-2d-module.md`
- Read: `docs/specs/resource-first-control-room-api-v2.md`
- Read: `docs/adr/0011-resource-first-api.md`

- [ ] Run current focused tests:

  ```bash
  pnpm --dir apps/control-room test -- --run browserActivityDiagnostics
  pnpm --dir apps/control-room test -- --run threadManagerModel
  pnpm --dir apps/control-room test -- --run viewport3dDiagnostics
  pnpm --dir apps/control-room test -- --run viewport-memory-stress
  ```

  Expected: existing tests pass. If a test fails before implementation, preserve the output as baseline debt and do not claim the recorder caused it.

- [ ] Run current audits:

  ```bash
  pnpm --dir apps/control-room audit:idle-performance
  pnpm --dir apps/control-room smoke:viewport-3d
  pnpm --dir apps/control-room audit:viewport-3d-memory-churn
  ```

  Expected: either pass, or fail with a captured pre-change failure that becomes part of the diagnostic target.

- [ ] Write a short baseline note in the implementation summary when work starts:

  ```text
  Baseline startup:
  - branch:
  - commit:
  - dev server URL:
  - first visible freeze window:
  - viewport first canvas:
  - WebGL context state:
  - long task support:
  - memory-churn result:
  ```

### Task 2: Define Recorder Types And Artifact Schema

**Files:**
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes.test.ts`

- [ ] Add exported types for:
  - `DiagnosticRecorderProfile`;
  - `DiagnosticRecordSeverity`;
  - `DiagnosticRecordLane`;
  - `DiagnosticRecord`;
  - `DiagnosticRequestRecord`;
  - `DiagnosticResourceRecord`;
  - `DiagnosticMemoryRecord`;
  - `DiagnosticViewport3DRecord`;
  - `DiagnosticConsoleRecord`;
  - `DiagnosticReactRecord`;
  - `DiagnosticBrowserMetricRecord`;
  - `DiagnosticArtifactV1`;
  - `DiagnosticSuspectReport`.

- [ ] Use stable event names. Required event names:

  ```ts
  export const DIAGNOSTIC_EVENT_NAMES = {
    instrumentationLoaded: "instrumentation-client.loaded",
    kernelCreated: "kernel.created",
    kernelProviderMounted: "kernel.provider-mounted",
    workspaceSettled: "workspace.settled",
    longTask: "browser.longtask",
    longAnimationFrame: "browser.long-animation-frame",
    eventLoopLag: "browser.event-loop-lag",
    requestStarted: "request.started",
    requestFinished: "request.finished",
    resourceCacheSet: "resource-cache.set",
    resourceCacheEvicted: "resource-cache.evicted",
    viewport3DMounted: "viewport-3d.mounted",
    viewport3DCanvasReady: "viewport-3d.canvas-ready",
    viewport3DContextLost: "viewport-3d.context-lost",
    viewport3DContextRestored: "viewport-3d.context-restored",
    viewport3DResourceTracked: "viewport-3d.resource-tracked",
    viewport3DResourceReleased: "viewport-3d.resource-released",
    memorySnapshot: "memory.snapshot",
    leakCheck: "memory.leak-check",
  } as const;
  ```

- [ ] Add tests that validate:
  - artifact version is exactly `1`;
  - every record has `timestampMs`, `lane`, `name`, `severity`;
  - request records do not include response bodies;
  - memory records can express unknown JS heap and estimated WebGL bytes separately.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnosticRecorderTypes
  ```

### Task 3: Add Pre-React Early Recorder

**Files:**
- Create: `apps/control-room/instrumentation-client.ts`
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/earlyDiagnosticRecorder.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/earlyDiagnosticRecorder.test.ts`
- Modify: `apps/control-room/app/layout.test.tsx`

- [ ] Implement `instrumentation-client.ts`:

  ```ts
  import { installEarlyDiagnosticRecorder } from "./src/kernel/performance/diagnostic-recorder/earlyDiagnosticRecorder";

  installEarlyDiagnosticRecorder();
  ```

- [ ] `earlyDiagnosticRecorder.ts` must:
  - avoid React imports;
  - tolerate missing `window`, `performance`, and `PerformanceObserver`;
  - install `window.__FULLMAG_DIAGNOSTIC_RECORDER__`;
  - record buffered `longtask`, `long-animation-frame`, `resource`, `navigation`, `paint`, `event`, and `measure` entries when supported;
  - record startup marks before React;
  - run a bounded event-loop lag probe only during active recording;
  - cap default boot buffer to 512 records;
  - preserve critical records before low-severity records under pressure;
  - expose `drain`, `mark`, `record`, `snapshot`, `exportArtifact`, and `stop`.

- [ ] Add this global contract:

  ```ts
  declare global {
    interface Window {
      __FULLMAG_DIAGNOSTIC_RECORDER__?: EarlyDiagnosticRecorderGlobal;
    }
  }
  ```

- [ ] Update `layout.test.tsx` so it still proves:
  - no inline scripts in `layout.tsx`;
  - no `next/script`;
  - no `beforeInteractive`;
  - no `dangerouslySetInnerHTML`;
  - project-root `instrumentation-client.ts` exists.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run earlyDiagnosticRecorder
  pnpm --dir apps/control-room test -- --run layout
  ```

### Task 4: Add Kernel DiagnosticRecorderController

**Files:**
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.ts`
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticRecorderConfig.ts`
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/useDiagnosticRecorderSnapshot.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.test.ts`
- Modify: `apps/control-room/src/kernel/types.ts`
- Modify: `apps/control-room/src/kernel/KernelProvider.tsx`
- Modify: `apps/control-room/src/kernel/KernelProvider.test.ts`
- Modify: `apps/control-room/src/kernel/browserFullmagConfig.ts`

- [ ] Add runtime config keys:
  - `enableDiagnosticRecorder`;
  - `diagnosticRecorderProfile`;
  - `diagnosticRecorderMaxRecords`;
  - `diagnosticRecorderMaxBytes`;
  - `diagnosticRecorderScenario`.

- [ ] Add `readonly diagnosticRecorder: DiagnosticRecorderController` to `KernelApi`.

- [ ] Instantiate `DiagnosticRecorderController` before module registration.

- [ ] The controller must:
  - drain the early recorder once;
  - record kernel lifecycle marks;
  - expose `subscribe`, `getSnapshot`, `getVersion`, `record`, `mark`, `start`, `stop`, `clear`, `exportArtifact`;
  - classify severity deterministically;
  - aggregate repeated low-value records;
  - expose dropped-record counts;
  - mirror selected records into `RequestDiagnosticsController` as `channel: "performance"` for legacy views.

- [ ] Add `DiagnosticRecorderConnector` in `KernelProvider.tsx`.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run DiagnosticRecorderController
  pnpm --dir apps/control-room test -- --run KernelProvider
  pnpm --dir apps/control-room test -- --run browserFullmagConfig
  ```

### Task 5: Capture Console, Page Errors, And Browser Snapshot

**Files:**
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticConsoleCapture.ts`
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticBrowserSnapshot.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticConsoleCapture.test.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticBrowserSnapshot.test.ts`

- [ ] Capture:
  - `console.error`;
  - `console.warn`;
  - `window.onerror`;
  - `window.onunhandledrejection`;
  - WebGL context loss/restoration events emitted from viewport probes.

- [ ] Browser snapshot must include:
  - user agent;
  - platform;
  - device pixel ratio;
  - viewport size;
  - hardware concurrency;
  - JS heap fields when available;
  - feature support booleans for each `PerformanceObserver` entry type used by the recorder.

- [ ] Do not permanently monkey-patch console without restoration. Capture returns a cleanup function.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnosticConsoleCapture
  pnpm --dir apps/control-room test -- --run diagnosticBrowserSnapshot
  ```

### Task 6: Upgrade MemoryBudgetRegistry Into Memory Ledger

**Files:**
- Modify: `apps/control-room/src/kernel/performance/MemoryBudgetRegistry.ts`
- Test: existing or new `apps/control-room/src/kernel/performance/MemoryBudgetRegistry.test.ts`

- [ ] Keep existing provider API compatible.

- [ ] Add:
  - `subscribe(listener)`;
  - `getVersion()`;
  - `registerLedgerEntry(entry)`;
  - `updateLedgerEntry(id, patch)`;
  - `releaseLedgerEntry(id)`;
  - `snapshotByCategory()`.

- [ ] Add categories:
  - `api-cache`;
  - `render-buffer`;
  - `session-state`;
  - `viewport-cache`;
  - `webgl`;
  - `worker`;
  - `object-url`;
  - `binary-buffer`;
  - `diagnostics-buffer`;
  - `other`.

- [ ] Every ledger entry must have:

  ```ts
  {
    byteLength: number;
    category: MemoryBudgetCategory;
    createdAtMs: number;
    entryCount: number;
    id: string;
    label: string;
    owner: string;
    releaseReason: string | null;
    maxBytes: number | null;
  }
  ```

- [ ] Tests must prove:
  - idempotent release;
  - provider snapshots still work;
  - ledger entries affect totals;
  - subscriptions stop after unsubscribe;
  - unbounded high entries are classified.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run MemoryBudgetRegistry
  ```

### Task 7: Instrument Request, Resource, Cache, And Decode Paths

**Files:**
- Modify: `apps/control-room/src/kernel/api/RequestDiagnosticsController.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/binaryDecodeScheduler.ts`
- Modify: `apps/control-room/src/kernel/resources/ResourceCache.ts`
- Modify: `apps/control-room/src/kernel/resources/useResource.ts`
- Tests: existing tests for each file plus focused diagnostic recorder tests.

- [ ] Add recorder hooks without adding direct component `fetch()`.

- [ ] Request records must include:
  - method;
  - route path;
  - resource key;
  - query identity;
  - start/end timestamps;
  - duration;
  - status;
  - content type;
  - byte length;
  - ETag;
  - `x-request-id`;
  - abort/network-error status.

- [ ] Resource records must include:
  - cache hit/miss;
  - revision used;
  - invalidation reason;
  - stale skip;
  - abort after unmount;
  - refetch caused by relevant vs unrelated revision.

- [ ] Decode records must include:
  - binary codec name;
  - payload bytes;
  - queue wait;
  - worker vs main-thread path;
  - decode duration;
  - transfer errors.

- [ ] Add tests that prove no response body is stored.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run RequestDiagnosticsController
  pnpm --dir apps/control-room test -- --run ControlRoomApi
  pnpm --dir apps/control-room test -- --run binaryDecodeScheduler
  pnpm --dir apps/control-room test -- --run ResourceCache
  pnpm --dir apps/control-room test -- --run useResource
  ```

### Task 8: Instrument React And Fullmag Performance Measures

**Files:**
- Modify: `apps/control-room/src/kernel/performance/browserActivityDiagnostics.ts`
- Modify: `apps/control-room/src/kernel/performance/performanceMeasureDiagnostics.ts`
- Modify: `apps/control-room/src/kernel/performance/threadManagerModel.ts`
- Tests: existing performance tests.

- [ ] Keep existing `fullmag.*` measure forwarding.

- [ ] Add structured detail parsing for:
  - `fullmag.react.render.*`;
  - `fullmag.viewport3d.*`;
  - `fullmag.api.requestBinaryResource.*`;
  - `fullmag.browser.longtask`;
  - `fullmag.browser.long-animation-frame`.

- [ ] Add explicit buckets:
  - startup;
  - React render;
  - viewport build;
  - viewport upload;
  - binary decode;
  - resource cache;
  - unknown.

- [ ] Ensure sampling cannot hide critical records over 100 ms.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run browserActivityDiagnostics
  pnpm --dir apps/control-room test -- --run performanceMeasureDiagnostics
  pnpm --dir apps/control-room test -- --run threadManagerModel
  ```

### Task 9: Add 3D Viewport Resource And Lifecycle Ledger

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/CanvasLifecycleProbe.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: related 3D layer tests.

- [ ] Track WebGL resources with owner and release reason:
  - geometry;
  - material;
  - texture;
  - render target;
  - GPU-side derived buffers;
  - worker;
  - observer/listener handles.

- [ ] Estimate bytes for:
  - typed array buffers;
  - geometry attributes;
  - index buffers;
  - texture dimensions and format when known;
  - render target dimensions.

- [ ] `CanvasLifecycleProbe` must record:
  - canvas mounted;
  - first WebGL context;
  - drawing buffer width/height;
  - first non-zero draw buffer;
  - `gl.isContextLost()`;
  - context lost/restored;
  - dirty reasons;
  - frame window summaries.

- [ ] `useViewport3DSceneModel.ts` must record structured timings for:
  - topology render model build;
  - field render model build;
  - scalar color mapping;
  - mesh quality colors;
  - FDM cuboid instance model;
  - vector glyph instance build;
  - primitive fallback geometry;
  - region overlay model.

- [ ] Tests must prove:
  - quantity switch does not rebuild topology when topology revision is unchanged;
  - 3D unmount releases module-owned resources;
  - context loss clears ownership and rebuilds from the current render model;
  - idle frames have dirty reasons.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run viewport3dDiagnostics
  pnpm --dir apps/control-room test -- --run useViewport3DSceneModel
  pnpm --dir apps/control-room test -- --run FdmCuboidLayer
  pnpm --dir apps/control-room test -- --run VectorFieldLayer
  pnpm --dir apps/control-room test -- --run viewport-memory-stress
  ```

### Task 10: Add Leak Detector And Snapshot Diffing

**Files:**
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticLeakDetector.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticLeakDetector.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport-memory-stress.test.ts`

- [ ] Define snapshot types:
  - `before`;
  - `after-load`;
  - `after-quantity-loop`;
  - `after-tab-switch-loop`;
  - `after-unmount`;
  - `after-forced-gc` when CDP exposes GC.

- [ ] Compare:
  - JS heap used;
  - total tracked bytes;
  - resource-cache bytes;
  - viewport-cache bytes;
  - WebGL estimated bytes;
  - active workers;
  - object URLs;
  - subscriptions;
  - dirty-frame count after idle.

- [ ] Leak classification:
  - `ok`: resource returned to baseline or accepted retained cache;
  - `watch`: small growth under threshold;
  - `leak-suspected`: repeated growth across loops;
  - `leak-confirmed`: module-owned resources remain after unmount.

- [ ] Thresholds:
  - JS heap growth warning: 25 MB after stress loop;
  - WebGL/module-owned resources after unmount: must be zero;
  - active viewport-only subscriptions after tab switch away: must be zero;
  - idle dirty frames without reason: fail.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnosticLeakDetector
  pnpm --dir apps/control-room test -- --run viewport-memory-stress
  ```

### Task 11: Add Artifact Export And Suspect Report

**Files:**
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticArtifactExport.ts`
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticSuspectReport.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticArtifactExport.test.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticSuspectReport.test.ts`

- [ ] Export functions:
  - `buildDiagnosticArtifactV1(snapshot)`;
  - `serializeDiagnosticArtifactJson(artifact)`;
  - `serializeDiagnosticStreamNdjson(records)`;
  - `buildDiagnosticSuspectReport(artifact)`;
  - `redactDiagnosticRecord(record)`.

- [ ] Suspect report must rank:
  - top 20 longest tasks;
  - top 20 viewport 3D timings;
  - top 20 slowest requests;
  - repeated request/resource keys;
  - memory growth deltas;
  - unreleased resources;
  - console/page errors before usable viewport;
  - records dropped by backpressure.

- [ ] Tests must include a synthetic artifact where the suspect report identifies:
  - a 500 ms topology build;
  - repeated field vector fetches;
  - unreleased texture;
  - console error during startup.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnosticArtifactExport
  pnpm --dir apps/control-room test -- --run diagnosticSuspectReport
  ```

### Task 12: Build In-App Diagnostic Recorder UI

**Files:**
- Create: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderDialog.tsx`
- Create: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderTimeline.tsx`
- Create: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderMemoryPanel.tsx`
- Create: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderViewport3DPanel.tsx`
- Create: `apps/control-room/src/kernel/layout/diagnostic-recorder/DiagnosticRecorderExportPanel.tsx`
- Create: `apps/control-room/src/design/styles/diagnostic-recorder.css`
- Tests: matching dialog/component tests.
- Modify: `apps/control-room/app/globals.css`
- Modify: `apps/control-room/src/design/styles/designStyles.test.ts`
- Modify: `apps/control-room/src/kernel/layout/AppMenuBar.tsx`
- Modify: `apps/control-room/src/kernel/layout/appMenuModel.tsx`
- Modify: `apps/control-room/src/kernel/layout/AppMenuBar.test.ts`

- [ ] Keep command id `tools.thread-manager` as an alias, but visible label becomes `Diagnostic Recorder`.

- [ ] Dialog sections:
  - `Overview`;
  - `Startup`;
  - `Main Thread`;
  - `Requests`;
  - `Memory`;
  - `Viewport 3D`;
  - `React`;
  - `Console`;
  - `Export`.

- [ ] UI controls:
  - start/stop recording;
  - choose profile;
  - clear current recording;
  - copy suspect report;
  - download JSON artifact;
  - show dropped-record counts;
  - show browser support gaps.

- [ ] Styling:
  - use `fm-` class prefix;
  - use token CSS only;
  - use shared `Button`, `Tabs`, `Dialog`;
  - use lucide icons;
  - no nested cards;
  - keep tables dense and scrollable;
  - no visible instructional marketing copy.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run DiagnosticRecorderDialog
  pnpm --dir apps/control-room test -- --run AppMenuBar
  pnpm --dir apps/control-room test -- --run designStyles
  ```

### Task 13: Add Footer Recorder Summary

**Files:**
- Create: `apps/control-room/src/modules/footer/DiagnosticRecorderFooterPanel.tsx`
- Test: `apps/control-room/src/modules/footer/DiagnosticRecorderFooterPanel.test.tsx`
- Modify: `apps/control-room/src/modules/footer/FooterModule.tsx`
- Modify: `apps/control-room/src/kernel/events/eventTypes.ts`

- [ ] Add footer tab id `diagnostics`.

- [ ] Add event `diagnostics:recorder-open-requested`.

- [ ] Footer panel must show:
  - recording state;
  - profile;
  - critical count;
  - slowest startup event;
  - tracked memory total;
  - viewport 3D resource count;
  - export button;
  - open full dialog button.

- [ ] The footer panel must use `useSyncExternalStore` through `useDiagnosticRecorderSnapshot`, not local polling.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run DiagnosticRecorderFooterPanel
  pnpm --dir apps/control-room test -- --run FooterModule
  ```

### Task 14: Add Playwright/CDP Recorder Script

**Files:**
- Create: `apps/control-room/scripts/record-diagnostics.mjs`
- Test: `apps/control-room/src/kernel/performance/diagnosticRecorderScript.test.ts`
- Modify: `apps/control-room/package.json`

- [ ] Add package scripts:

  ```json
  {
    "diagnostics:record": "node scripts/record-diagnostics.mjs",
    "diagnostics:record:viewport-3d": "CONTROL_ROOM_DIAGNOSTICS_SCENARIO=viewport-3d node scripts/record-diagnostics.mjs",
    "diagnostics:record:memory-leak": "CONTROL_ROOM_DIAGNOSTICS_SCENARIO=memory-leak node scripts/record-diagnostics.mjs"
  }
  ```

- [ ] Script inputs:
  - `CONTROL_ROOM_URL`;
  - `CONTROL_ROOM_API_BASE_URL`;
  - `CONTROL_ROOM_DIAGNOSTICS_SCENARIO`;
  - `CONTROL_ROOM_DIAGNOSTICS_INTERACTIVE`;
  - `CONTROL_ROOM_DIAGNOSTICS_HEADLESS`;
  - `CONTROL_ROOM_DIAGNOSTICS_OUTPUT_DIR`;
  - `CONTROL_ROOM_DIAGNOSTICS_ALLOW_MISSING_SESSION`;
  - `CONTROL_ROOM_DIAGNOSTICS_TRACE`;
  - `CONTROL_ROOM_DIAGNOSTICS_TIMEOUT_MS`.

- [ ] Launch Chromium with:
  - `--js-flags=--expose-gc`;
  - `--enable-precise-memory-info`;
  - existing sandbox behavior from repo scripts.

- [ ] Use CDP where available:
  - `Performance.enable`;
  - `Runtime.getHeapUsage`;
  - `HeapProfiler.enable`;
  - `HeapProfiler.collectGarbage`;
  - `Tracing.start` / `Tracing.end` when `CONTROL_ROOM_DIAGNOSTICS_TRACE=1`.

- [ ] Capture Playwright-side:
  - console errors/warnings;
  - page errors;
  - request/response timings;
  - websocket frames metadata;
  - screenshots at key phases;
  - CDP browser metrics;
  - exported in-page artifact.

- [ ] Write output directory with the artifact contract above.

- [ ] Print:

  ```text
  Diagnostic artifact: <path>
  Suspects: <top 5 summary>
  ```

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnosticRecorderScript
  ```

### Task 15: Add Scripted Scenarios

**Files:**
- Modify: `apps/control-room/scripts/record-diagnostics.mjs`
- Create: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticScenarioModel.ts`
- Test: `apps/control-room/src/kernel/performance/diagnostic-recorder/diagnosticScenarioModel.test.ts`

- [ ] Scenario `boot`:
  - load `/workspace`;
  - wait for early recorder;
  - wait for kernel recorder;
  - wait for `workspace.settled`;
  - wait five idle seconds;
  - export.

- [ ] Scenario `viewport-3d`:
  - run `boot`;
  - wait for `.fm-viewport-3d canvas`;
  - verify canvas visible;
  - verify WebGL context not lost;
  - perform camera gesture;
  - switch quantity sequence `m`, `H_eff`, `H_demag`, `H_ex`, `m`;
  - wait for idle;
  - export.

- [ ] Scenario `memory-leak`:
  - run `viewport-3d`;
  - take snapshot;
  - repeat quantity switches;
  - switch to `cross-section-image` and back to `viewport-3d`;
  - switch to `analysis-plots` and back to `viewport-3d`;
  - force GC through CDP when available;
  - take snapshot;
  - export leak report.

- [ ] Scenario `interactive`:
  - launch headed browser;
  - start recorder;
  - wait for user stop;
  - export.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnosticScenarioModel
  ```

### Task 16: Add Recorder Audits

**Files:**
- Create: `apps/control-room/scripts/audit-diagnostic-recorder.mjs`
- Create: `apps/control-room/scripts/audit-diagnostic-memory-leak.mjs`
- Test: `apps/control-room/src/kernel/performance/diagnosticRecorderAuditScript.test.ts`
- Modify: `apps/control-room/package.json`

- [ ] Add package scripts:

  ```json
  {
    "audit:diagnostic-recorder": "node scripts/audit-diagnostic-recorder.mjs",
    "audit:diagnostic-memory-leak": "node scripts/audit-diagnostic-memory-leak.mjs"
  }
  ```

- [ ] `audit:diagnostic-recorder` must assert:
  - recorder global exists before React;
  - kernel recorder drains early records;
  - artifact export includes every stream;
  - suspect report is non-empty when synthetic problems are injected;
  - no unbounded growth after recording stops.

- [ ] `audit:diagnostic-memory-leak` must assert:
  - 3D module-owned resources return to zero after unmount;
  - object URLs are revoked;
  - workers are idle/released;
  - resource-cache growth is within threshold;
  - no idle frames without dirty reasons.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnosticRecorderAuditScript
  pnpm --dir apps/control-room audit:diagnostic-recorder
  pnpm --dir apps/control-room audit:diagnostic-memory-leak
  ```

### Task 17: Update Existing Smoke And Audit Scripts To Attach Artifacts

**Files:**
- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Modify: `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs`
- Modify: `apps/control-room/scripts/audit-idle-performance.mjs`
- Tests: existing script source tests.

- [ ] On failure, `smoke-viewport-3d.mjs` must print whether a diagnostic artifact was available and where it was written.

- [ ] `audit-viewport-3d-memory-churn.mjs` must compare its current heap measurements with recorder memory ledger deltas.

- [ ] `audit-idle-performance.mjs` must continue banning `setInterval`, always-on RAF, and unbounded viewport render loops. The recorder must not add new exceptions except documented one-shot probes.

- [ ] Run:

  ```bash
  pnpm --dir apps/control-room test -- --run computePerformanceSmokeScript
  pnpm --dir apps/control-room test -- --run viewportSmokeProjectionScript
  pnpm --dir apps/control-room audit:idle-performance
  ```

### Task 18: Update Frontend Performance Spec

**Files:**
- Modify: `docs/specs/frontend-v2/17-performance-memory-profiler.md`

- [ ] Add a `Diagnostic Recorder` section that documents:
  - boot recorder;
  - forensic profiles;
  - artifact streams;
  - memory leak stress loops;
  - no-response-body rule;
  - no continuous idle sampling rule;
  - Playwright/CDP harness;
  - final verification commands.

- [ ] Keep spec consistent with this plan and with viewport lifecycle specs.

### Task 19: Final Verification

- [ ] Run targeted tests:

  ```bash
  pnpm --dir apps/control-room test -- --run diagnostic
  pnpm --dir apps/control-room test -- --run MemoryBudgetRegistry
  pnpm --dir apps/control-room test -- --run RequestDiagnosticsController
  pnpm --dir apps/control-room test -- --run ResourceCache
  pnpm --dir apps/control-room test -- --run viewport3dDiagnostics
  pnpm --dir apps/control-room test -- --run viewport-memory-stress
  ```

- [ ] Run browser audits:

  ```bash
  pnpm --dir apps/control-room audit:diagnostic-recorder
  pnpm --dir apps/control-room audit:diagnostic-memory-leak
  pnpm --dir apps/control-room audit:idle-performance
  pnpm --dir apps/control-room smoke:viewport-3d
  pnpm --dir apps/control-room diagnostics:record:viewport-3d
  pnpm --dir apps/control-room diagnostics:record:memory-leak
  ```

- [ ] Run app quality gates:

  ```bash
  pnpm --dir apps/control-room typecheck
  pnpm --dir apps/control-room lint
  pnpm --dir apps/control-room test
  ```

- [ ] If network access is available, run:

  ```bash
  npx -y react-doctor@latest apps/control-room --verbose --diff
  ```

  If unavailable, report the network limitation and rely on local gates.

## Done Criteria

The implementation is done only when:

- `diagnostics:record` creates a readable artifact directory.
- UI export creates `fullmag-diagnostics-*.json`.
- The artifact contains manifest, summary, timeline, performance, requests, resources, memory, viewport 3D, console, React, browser metrics, and suspect report.
- The recorder starts before React through `instrumentation-client.ts`.
- The kernel drains early records and continues recording without hydration mismatch.
- The tool catches a synthetic 500 ms main-thread stall.
- The tool catches synthetic unreleased WebGL resources in a test.
- The memory-leak scenario proves `viewport-3d` module-owned resources return to zero after unmount.
- The idle audit still passes.
- No response bodies, cookies, auth headers, or heavy binary payloads are stored.
- No direct component `fetch()` or hand-built `/v2/...` strings are introduced.
- No always-on app-side sampling loop exists.
- The final report includes the artifact path and top suspects.

## Deferred Backend Persistence

Do not implement this until the frontend-first recorder is working.

Future backend persistence would require:

- `POST /v2/sessions/current/diagnostics/client-recordings`;
- `GET /v2/sessions/current/diagnostics/client-recordings/{recording_id}`;
- OpenAPI v2 schema updates;
- generated frontend transport/types;
- central `ControlRoomApi` facade methods;
- resource hooks;
- retention and redaction policy;
- tests proving heavy blobs do not enter `status`.

Until then, the source of truth for browser diagnosis is the exported local artifact.
