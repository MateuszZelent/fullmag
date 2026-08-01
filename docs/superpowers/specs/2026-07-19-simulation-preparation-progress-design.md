# Simulation Preparation Progress Design

**Status:** Approved design
**Date:** 2026-07-19

## 1. Problem

The Control Room currently blocks the workspace with a minimal startup message such as
`Preparing simulation` and `Connecting to the local simulation backend.` While Fullmag
materializes the script, validates and plans the problem, constructs the shared domain,
builds the mesh, post-processes it, and initializes the solver, the user cannot tell which
operation is active, how long it has taken, or whether useful progress is still being made.

The startup surface must report backend-owned preparation state. It must not simulate
progress in the browser or infer detailed runtime work from elapsed wall time.

## 2. Goals

1. Cover the complete preparation lifecycle from local runtime startup through a
   runtime-ready solver, not only mesh generation.
2. Show the active operation, completed and pending stages, elapsed and per-stage times,
   and bounded preparation log entries.
3. Show a determinate percentage only when the backend reports measurable progress.
4. Preserve the last valid snapshot across a transient connection loss.
5. Leave actionable failure information visible when preparation fails.
6. Keep the v2 status resource thin and preserve resource-first ownership.
7. Provide accessible, testable behavior and real browser-level visual verification.

## 3. Non-goals

- Estimating an ETA from historical runs.
- Streaming raw process stdout or unrestricted tracebacks into the browser.
- Replacing detailed mesh build, solver, or diagnostics resources.
- Persisting canonical preparation state in a frontend store or local storage.
- Making WebSocket events an authoritative state transport.
- Changing the scientific meaning of validation, planning, meshing, or solver setup.

## 4. User Experience

The startup gate uses the approved operational layout (visual option A). It contains:

- an eyebrow identifying simulation preparation;
- the active stage title and a short backend-authored detail;
- requested and resolved execution context when available;
- total elapsed time;
- a global progress bar;
- an ordered stage list with state and duration;
- a bounded, timestamped log visible beside the stage list;
- a short explanation that the workspace opens after solver initialization.

The stage list and log are visible simultaneously. The log is not hidden behind a
disclosure action because its primary purpose is to make long or stalled startup work
observable.

### 4.1 Connection bootstrap

Before the first API snapshot, the panel retains the existing connection message and uses
an indeterminate progress presentation. No percentage, stage count, or ETA is fabricated.

### 4.2 Active preparation

Once the preparation resource is available, the panel renders its ordered stage list. A
stage is one of `pending`, `active`, `completed`, `failed`, or `skipped`. Completed stages
show their final duration. The active stage shows a live duration derived from backend
timestamps and its last reported detail.

The global progress bar combines completed stage weights with the active stage's reported
fraction only when the backend supplies a determinate value. If the active operation has no
measurable denominator, the bar remains indeterminate while the stage and elapsed time keep
updating. Fullmag must not assign arbitrary percentages to validation, planning, or solver
initialization merely to make the bar move.

### 4.3 Log behavior

Preparation log entries include a timestamp, severity, owning stage, and safe message. The
panel follows new entries only while the viewport is already at the bottom. If the user
scrolls upward, new entries do not steal the scroll position; a compact new-entry affordance
returns to the live tail.

The UI receives a bounded tail suitable for startup diagnosis. Full logs remain owned by the
diagnostics resource. Messages must exclude secrets, unrestricted environment values, host
paths, and raw stack traces.

### 4.4 Ready transition

When preparation becomes `ready`, the panel briefly confirms completion and then mounts the
workspace. The preparation history remains available through diagnostics after the overlay
closes.

### 4.5 Failure and reconnect

On a preparation failure, the panel remains open and marks the failed stage. It shows the
safe failure summary, stage duration, recent log entries, and actions to copy bounded
diagnostics or open the full diagnostics surface. It does not fall through to an empty
workspace.

During a transient connection loss, the last valid snapshot remains visible with an explicit
stale/reconnecting state. Reconnection refetches the authoritative HTTP resource. Contract,
authorization, and other non-transient API errors remain distinguishable from connection
startup.

## 5. Canonical Stage Model

The preparation projection uses stable stage identifiers in execution order:

1. `runtime_startup`
2. `script_materialization`
3. `validation`
4. `planning`
5. `domain_preparation`
6. `meshing`
7. `mesh_postprocessing`
8. `solver_initialization`
9. `ready`

Backends may mark an inapplicable stage as `skipped`, but they must not silently remove a
canonical stage after the preparation projection is published. A backend-specific detail may
refine the active operation without adding browser-defined semantics.

Each stage projection contains:

- stable `id`;
- user-facing `label` and bounded `detail`;
- lifecycle `status`;
- optional `started_at_unix_ms` and `completed_at_unix_ms`;
- optional final or current `duration_ms`;
- optional `progress_percent` in the inclusive range `0..100`;
- optional `progress_label` describing the measured unit;
- optional link or revision pointer to its owning detailed resource.

The aggregate contains a preparation id and revision, aggregate status, active stage id,
overall timestamps, requested and resolved execution summaries, the ordered stages, and a
bounded log tail.

Backend timing uses a monotonic clock for duration calculation. Unix timestamps are supplied
for presentation and correlation only. Browser wall time is not the canonical duration.

## 6. Resource-first API Design

The canonical snapshot is:

`GET /v2/sessions/current/simulation/preparation`

The `simulation` family owns the aggregate because it describes preparation of the executable
run. Detailed mesh state remains owned by `meshing/builds/current`; detailed engine logs remain
owned by `diagnostics/engine-log`. The preparation resource contains only bounded projections,
links, and revision pointers needed to explain startup.

`GET /v2/sessions/current/status` adds only
`resources.simulation_preparation_revision`. It does not absorb the stage list or log tail.

The backend schema and OpenAPI v2 contract change first. Generated Control Room v2 types and
transport are regenerated, then a handwritten facade method and resource hook expose the
snapshot. React components do not construct endpoint strings or call `fetch()`.

HTTP v2 remains authoritative. WebSocket events announce the changed preparation revision and
invalidate the resource cache; they do not carry the full preparation snapshot or log.

## 7. Backend State Ownership

The local live workspace owns one bounded preparation state object and updates it at the
existing orchestration boundaries. Each transition is explicit and idempotent:

- runtime bootstrap publishes `runtime_startup`;
- script bridge boundaries publish `script_materialization`;
- validation and planner entry/exit publish their respective stages;
- existing structured mesh events update `domain_preparation`, `meshing`, and
  `mesh_postprocessing` without duplicating the detailed mesh build resource;
- solver construction publishes `solver_initialization`;
- successful runtime readiness publishes `ready`;
- an error records the owning failed stage before propagating.

The state object maintains bounded log entries and increments its revision on a semantic
change. Repeated identical observations do not churn revisions. Existing engine log behavior
continues independently.

## 8. Frontend Ownership

Preparation is server state and remains in the resource cache. It is not copied into Zustand,
React context, or browser persistence.

The existing kernel startup gate consumes a focused preparation resource selector alongside
the thin status selector. A pure adapter produces the view model for connection, active,
stale, ready, and failed states. The view renders shared accessible primitives and `fm-`
prefixed classes using existing Catppuccin-backed `--fm-*` tokens.

The overlay remains kernel-owned because it gates mounting of every workspace slot. It does
not import module internals. The diagnostics action uses the kernel event/command boundary to
open the existing diagnostics surface.

## 9. Accessibility and Motion

- The aggregate bar exposes semantic progressbar attributes when determinate.
- Indeterminate work is announced as a textual active stage, not as a false numeric value.
- Stage changes and terminal failures use a polite live region; log entry churn is not read
  continuously by assistive technology.
- Stage state is communicated by text and iconography, not color alone.
- Log and diagnostic actions are keyboard reachable with visible focus.
- Reduced-motion mode disables continuous decorative animation while preserving state
  changes.
- The panel remains usable at narrow desktop widths and with increased text size.

## 10. Error Semantics

The aggregate preparation status is one of `connecting`, `running`, `ready`, or `failed`.
Transient transport loss is a frontend resource condition layered over the last server
snapshot; it is not written back as a preparation stage.

Failures contain a stable error code, safe user summary, owning stage id, and optional
diagnostics correlation id. Detailed internal errors remain in diagnostics and persisted log
files. A stage cannot be both completed and failed, timestamps cannot regress, and completion
cannot precede start.

## 11. Verification

### 11.1 Backend and contract

- Unit tests cover legal transitions, skipped stages, idempotent updates, monotonic durations,
  bounded logs, percentage bounds, ready completion, and stage-owned failures.
- API route tests cover active, ready, failed, and unavailable preparation resources.
- Status contract tests prove that only the revision pointer is added.
- OpenAPI generation and generated transport/type checks pass.
- Realtime tests prove that events invalidate the HTTP resource without carrying its body.

### 11.2 Frontend

- Pure view-model tests cover connecting, determinate, indeterminate, skipped, stale,
  reconnecting, ready, and failed states.
- Resource-hook tests cover revision invalidation, retention of stale data, and recovery.
- Component tests cover stage ordering, formatted durations, bounded log rendering, semantic
  progress attributes, reduced motion, copy diagnostics, and scroll-follow behavior.
- Startup-gate tests prove workspace slots remain unmounted until `ready` and remain unmounted
  after failure.

### 11.3 Integrated UI

A real browser smoke starts a controlled preparation fixture and verifies:

- the overlay and progress surface are visible;
- stage and log updates arrive without remounting workspace slots;
- a determinate mesh update changes the numeric bar;
- an indeterminate stage never claims a percentage;
- the WebGL workspace mounts only after readiness;
- failed and reconnecting states remain readable;
- the final layout matches approved option A at representative and narrow viewport sizes.

Control Room typecheck, zero-warning lint, tests, targeted React Doctor, and the relevant strict
resource-first/contract gates must pass before completion is claimed.

## 12. Rollout and Compatibility

The existing status-derived startup copy remains the temporary fallback only while the new
preparation resource is unavailable during process connection. Once HTTP is reachable, the
resource projection is canonical. There is no v1 endpoint or v2-to-v1 fallback.

The fallback may be removed only after every supported local launch path publishes the
preparation resource before script materialization. Its presence and removal criterion must
be documented in the implementation plan and final change summary.

## 13. Completeness Checklist

- [x] Full startup lifecycle is in scope.
- [x] Approved operational layout A is specified.
- [x] Real versus indeterminate progress semantics are explicit.
- [x] Backend timing and bounded logging ownership are explicit.
- [x] Thin status and HTTP/realtime responsibilities are preserved.
- [x] Failure, reconnect, accessibility, and reduced-motion behavior are defined.
- [x] Backend, contract, frontend, and browser verification are defined.
- [x] Transitional fallback has a removal criterion.
