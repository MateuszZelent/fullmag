# Task 2 implementer report: truthful FEM throughput metrics

## Scope

Implemented the Task 2 diagnostics contract on top of Task 1's closed profiler
windows. This task does not change the native FEM numerical algorithm. It makes
runtime throughput, successful publication throughput, tolerance duration, and
footer counter semantics truthful and explicitly owned.

The pre-existing `.superpowers/sdd/progress.md` modification was not edited and
is excluded from this task's staging and commit.

## Contract implemented

- `diagnostics/solver-profile` owns three optional rate objects:
  `solver_steps_per_second`, `end_to_end_steps_per_second`, and
  `published_steps_per_second`.
- Every rate object contains exactly `value`, `window_step_count`,
  `window_wall_time_ns`, and `source_revision`.
- Solver and end-to-end rates use the same latest closed Task 1 profiler sample:
  the same accepted-step count and source revision, with native solver time and
  monotonic end-to-end span as their respective denominators.
- A rate is absent when its step count or wall-time denominator is zero.
- Published throughput advances only after a delta HTTP sync succeeds or a
  failed delta is recovered by a successful full-snapshot HTTP sync. Repeated
  publication of the same step does not increment its successful-step window.
- `status.metrics.steps_per_second` remains only as a deprecated thin scalar
  alias of the end-to-end rate. It is null without a closed span and has no
  lifetime or last-step fallback.
- `simulation/stages/execution` owns `time_to_tolerance_seconds`. It is emitted
  only for `status=completed`, `converged=true`, and a `torque`, `energy`, or
  `gradient` stop reason with a valid start/completion timestamp span.
- Footer diagnostics label artifact enqueue-now cost, queue current/max,
  writer delta/cumulative, and GPU synchronization delta/cumulative explicitly.
- OpenAPI JSON and TypeScript types were regenerated with the official project
  generator; no generated contract was edited by hand.

## Docs-first changes

- Updated `docs/adr/0011-resource-first-api.md` with resource ownership,
  window definitions, compatibility behavior, and stage-duration ownership.
- Updated `docs/specs/resource-first-control-room-api-v2.md` with the exact
  rate object shape, successful-publish boundary, thin-status restriction, and
  tolerance-qualified stop reasons.

## TDD evidence

RED tests were added before production changes:

- runner failed because `SolverRateDiagnostics` did not exist;
- CLI failed because `SuccessfulPublishWindow` and successful HTTP counters did
  not exist;
- API failed because the rate resource, end-to-end-only alias, and tolerance
  duration projector did not exist;
- footer tests defined the required rate labels and current/delta/cumulative
  counter wording before the UI implementation.

GREEN focused verification:

- `cargo test -p fullmag-runner solver_profile::tests -- --nocapture`:
  12 passed.
- `cargo test -p fullmag-cli live_workspace::tests -- --nocapture`:
  20 passed.
- API compatibility alias test: passed.
- API tolerance-duration tests: 2 passed.
- API integration test proving null status rate without a closed span: passed.
- `vitest` footer diagnostics and telemetry tests: 21 passed.

## Broader verification

- Official OpenAPI/type/client generation: passed.
- `check:api-hygiene`: passed.
- Control Room typecheck: passed.
- Control Room lint with zero warnings: passed.
- Full Control Room test suite: 390 files passed, 1 skipped; 3731 tests
  passed, 1 skipped.
- `git diff --check`: passed.
- Managed native gate:
  `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: passed.
  The gate rebuilt and validated the managed FEM GPU runtime bundle, built the
  native relaxation/source contracts, and completed its GPU and CPU relaxation
  smoke matrix.

## Existing unrelated failure

The full `fullmag-api` run initially reported 666/668 tests passed. One failure
was a stale Task 2 test that required the removed fabricated rate fallback; it
was replaced with the approved null-without-closed-span assertion and passes in
isolation. The remaining
`router_v2::tests::display_patch_accepts_partial_update` failure expects
`presentation.vector_glyphs=true`, while current base behavior returns false.
It also fails in isolation. This task does not touch display presentation code,
and the only change in `router_v2/tests.rs` is the Task 2 status-rate test, so
the unrelated presentation assertion was not changed or masked here.

## Completion assessment

The Task 2 throughput and duration contract is implemented, production
executable, generated through the official API path, and covered by focused
Rust/UI tests plus the managed native FEM runtime gate. It does not by itself
claim a solver speedup; it provides the truthful measurement surface required
to validate future speedups.
