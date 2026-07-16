# Frontend v2 - Performance, Memory, and Profiler

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Performance Principle

Frontend v2 must be quiet when nothing changes. The shell may receive realtime events, but only modules whose resource revisions changed should recompute or render.

Performance work must be measured. "Feels faster" is not evidence.

## 2. Budgets

Initial budgets for the v2 implementation:

| Area | Budget |
|---|---|
| Idle 3D viewport frames | zero after settling, unless solver animation is explicitly enabled |
| Idle API polling | none; realtime invalidation plus resource fetches |
| Main-thread long tasks | no repeated long tasks during idle |
| Module root render | no render caused by unrelated module-local state |
| WebGL resource growth | bounded across 3D/2D switches and quantity changes |
| Explorer rebuild | only on relevant resource revision |
| Chart resize | observer-driven, no interval polling |

Budgets can be tightened after the first implementation has baseline measurements.

### 2.1 Visualization Debug Budgets

Visualization diagnostics are opt-in and demand-driven. A serialized
`VisualizationDebugController` snapshot is capped at **64 KiB** measured as the
UTF-8 byte length of its serialized JSON, not JavaScript string length. The
limit is `new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <=
64 * 1024`. Per snapshot,
diagnostic collections are capped at 12 sampled points, 8 displayed components
per point, 20 issues, and 8 matched request records. Oversized input is rejected
or replaced by a bounded `snapshot-size-limit` issue; it is never retained as an
unbounded diagnostic log.

When no `Visualization > Debug` node is selected, the zero-work contract is:

- no value scan or sample extraction;
- no additional field-meta hook or heavy field request;
- no polling, timer, or periodic memory sampling;
- no viewport frame or render-model rebuild caused by diagnostics;
- no retained target snapshot after demand is released.

Opening Debug reuses the field payload already consumed by the viewport and
must add zero heavy FMVP requests. A cooperative full-value scan is permitted
only under active demand, is cancellable on target/resource/revision changes or
unmount, and publishes bounded start/final states rather than per-chunk updates.
Repeated open/close stress must leave subscription, timer, scan, object URL, and
snapshot counts at baseline.

## 3. Render Reason Instrumentation

Development builds expose render reasons for:

- module root render;
- resource hook refetch;
- viewport dirty frame;
- chart redraw;
- explorer tree rebuild;
- inspector panel remount.

Render reasons are diagnostic metadata, not product state. They live in diagnostics controllers/stores and are disabled or sampled in production.

## 4. Memory Ownership

| Resource | Owner | Release trigger |
|---|---|---|
| WebGL geometry/material/texture/render target | 3D resource tracker | topology/style change or module unmount |
| decoded field buffer | resource cache or renderer buffer owner | resource revision eviction or consumer release |
| worker | module hook or kernel worker pool | module unmount or idle timeout |
| ECharts instance | chart component | chart unmount |
| event subscription | event hook | component/module unmount |
| resize observer | component hook | component unmount |
| object URL | creating module | after download/export action completes |

No large typed array should be hidden in React state.

## 5. Profiler Surfaces

Diagnostics module should show:

- API requests by resource key, status, duration, revision;
- resource cache size and entries;
- active event subscriptions by event type;
- active timers and animation frames in development mode;
- viewport dirty reasons and frame counts;
- WebGL resource count by class;
- chart instance count;
- memory stress test summary;
- active feature flags and removal dates.

## 6. Required Audits

### Idle Audit

Procedure:

1. open workspace;
2. wait until initial resources settle;
3. do not move mouse or camera;
4. record render frame count, requests, long tasks, and memory for a fixed window;
5. fail if the viewport or chart renders without a dirty reason.

### Viewport Memory Stress

Procedure:

1. mount 3D viewport;
2. load mesh and field;
3. switch quantities repeatedly;
4. switch 3D/2D repeatedly;
5. select and clear objects;
6. unmount viewport;
7. assert resource tracker reaches zero for module-owned resources.

### Resource Hook Audit

Procedure:

1. emit unrelated revision tick;
2. assert hook does not refetch;
3. emit relevant revision tick;
4. assert hook refetches exactly once;
5. abort while pending and assert no state update after unmount.

## 7. Anti-Patterns

- `setInterval` for resource refresh.
- `requestAnimationFrame` rendering every frame while idle.
- `useEffect` that derives state and sets state on every render.
- object identity churn from large inline objects passed through module roots.
- React state holding geometry, material, texture, or large typed arrays.
- diagnostics that continuously sample or log without a user-enabled profile.
- fixing OOM by hiding errors or disabling layers instead of releasing resources.

## 8. Verification Commands

Target commands once v2 exists:

- `pnpm --dir apps/control-room test -- --run viewport-memory-stress`
- `pnpm --dir apps/control-room test -- --run resource-hooks`
- `pnpm --dir apps/control-room audit:idle-performance`
- `pnpm --dir apps/control-room typecheck`
- `npx -y react-doctor@latest apps/control-room --verbose --diff`
