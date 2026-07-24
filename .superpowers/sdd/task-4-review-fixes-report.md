# Task 4 review fixes: FEM live publication callback ownership

## Scope

This follow-up addresses the two P1 findings from the independent review of
commit `30cbe0c2b419ec8a11f9a062c68c058ecdf518f2`:

1. the production callback cloned the complete retained `LiveStepView`,
   including a potentially large magnetization buffer;
2. preview ingestion serialized JSON and cloned preview buffers while holding
   the live-workspace state lock on the solver callback path.

No native FEM equations, solver parameters, MFEM/hypre configuration, CUDA
kernels, or accepted performance baselines were changed.

## TDD evidence

Two production-path tests exercise
`LocalLiveWorkspace::update_profiled -> apply_live_step_update_to_workspace_state`
for five callbacks with 3,000,000-element `f64` buffers:

- `production_ingest_preserves_large_retained_magnetization_by_pointer`
- `production_ingest_moves_large_preview_into_single_pending_owner`

The RED state reproduced both findings: the retained magnetization pointer
changed, and preview data appeared in the persistent cache during callback
ingestion. The GREEN state proves pointer preservation, single pending preview
ownership, no callback JSON materialization, and callback p95 below 10 ms.

## Implementation

- Production ingestion now temporarily takes and restores retained
  magnetization and FEM mesh generation identity by move instead of cloning the
  previous `LiveStepView`.
- Incoming preview fields are consumed with `Option::take()` and moved into the
  pending publication cache. The callback no longer serializes them into
  `latest_fields` and does not create persistent preview copies.
- Replaced preview buffers are deferred in
  `superseded_pending_preview_fields`; the publisher worker drops them after
  releasing the workspace state lock.
- The publisher worker takes publication parts under the lock, then clones the
  one persistent preview copy outside the lock. The original allocation is
  moved into the outgoing payload. Retry ownership remains in the existing
  pending-payload slot.
- The retry test now verifies that destructively taken mesh and preview data
  survive a failed publish and that the successful retry updates the persistent
  preview cache.
- The test-only FEM mesh clone counter is thread-local so concurrent publisher
  activity cannot contaminate exact call-graph assertions.

## Source contract

The FEM mesh hot-loop contract remains at 191 semantic references and 64
producers. Its pinned digest changed from
`12767...` to
`92f096f11bd1d7eea7bd621c35c6e36ac782f609e7380600652180c5c83adf44`
because the protected containing struct literal gained only the new empty
deferred-preview field. No FEM mesh access or producer was added.

## Verification

- `CARGO_TARGET_DIR=/tmp/fullmag-task4-target cargo test -p fullmag-cli`:
  PASS, 228/228.
- `CARGO_TARGET_DIR=/tmp/fullmag-task4-target cargo test -p fullmag-runner solver_profile --lib`:
  PASS, 17/17 (existing warnings only).
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-source-contract`:
  PASS, including the 191/64 semantic inventory and native contracts.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`:
  PASS after a fresh managed runtime rebuild. GPU validated
  `llg_overdamped`, `projected_gradient_bb`, and `nonlinear_cg`; GPU
  `tangent_plane_implicit` was explicitly unsupported and skipped. CPU
  validated all four algorithms. Final status: FEM relaxation runtime smoke
  completed.

## Repeat-5 performance evidence

The repeat-5 gate was run twice without changing the accepted baseline.
Both runs passed all 10 numerical rows, CPU/GPU consistency, demag convergence,
stable solver mesh, and strict GPU residency. Both failed only the accepted
GPU wall-time p95 threshold:

| Run | GPU wall p50 | GPU wall p95 | CPU wall p50 | GPU demag p50 | CPU demag p50 | Baseline result |
|---|---:|---:|---:|---:|---:|---|
| 1 | 5497.755 ms | 5614.810 ms | 10551.380 ms | 56.463 ms | 117.250 ms | +7.46%, FAIL |
| 2 | 5487.906 ms | 5699.293 ms | 10920.272 ms | 59.270 ms | 119.075 ms | +9.07%, FAIL |

The current GPU path is about 1.92-1.99x faster than CPU in total wall time and
about 2.01-2.08x faster in demag apply for these runs. The baseline was not
relaxed or regenerated.

Because both standalone runs missed only the historical timing threshold, a
controlled same-container A/B compared the actual current executable against
the immutable Task 0 executable in forward and reverse order. Every side used
the same fixture, arguments, warmup, five CPU repetitions, five GPU
repetitions, and strict numerical/residency gates.

- immutable SHA-256:
  `540d7e6bf7e798862753852141b0971585421e6e871f8ab75a8226fb3875f8b7`
- current SHA-256:
  `86f0d5436e5d9786ee11c846d32317793d00e06875f7149886f49e35d6adced3`

| Order | Runtime | CPU p50 | CPU p95 | GPU p50 | GPU p95 | Result |
|---|---|---:|---:|---:|---:|---|
| forward, first | immutable | 10675.854 ms | 11539.465 ms | 5477.410 ms | 5718.807 ms | 10/10 PASS |
| forward, second | current | 10618.513 ms | 11041.195 ms | 5260.379 ms | 5574.918 ms | 10/10 PASS |
| reverse, first | current | 10761.408 ms | 11103.267 ms | 5509.255 ms | 5555.668 ms | 10/10 PASS |
| reverse, second | immutable | 11004.245 ms | 11533.984 ms | 5362.198 ms | 5870.394 ms | 10/10 PASS |

Current was faster by GPU p95 in both windows: 2.52% in forward order and
5.36% in reverse order. It was also faster by CPU p95 by 4.32% and 3.73%,
respectively. Reverse-order immutable had a 2.74% lower GPU p50 but much higher
variance and p95. This resolves the standalone threshold misses as
environment/window variation, not a Task 4 regression.

NVIDIA telemetry showed idle P8 at 44-49 C, 14.97-16.18 W, and 210/405 MHz,
then P2 at 51-56 C, 71.10-74.33 W, and 2550-2775/11251 MHz between/after runs.
There was no thermal or power-limit signature. Raw ignored artifacts are
retained under `.fullmag/reports/task4_ab_{forward,reverse}_*.{csv,json}`.

## Remaining limitation

The callback-specific tests prove allocation ownership and a local callback
latency bound, but the production benchmark CSV does not yet expose callback
or publication-gap fields. Therefore this follow-up is implemented and runtime
executable, while its isolated end-to-end contribution to solver wall time is
not separately measurable from the current benchmark artifact.
