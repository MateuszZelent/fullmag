# Task 4 implementer report: FEM live publication off the solver callback

Date: 2026-07-21

## Scope delivered

- `StepUpdate` is consumed by value through offset and live-state application; heavy magnetization and preview payloads use move/`Option::take` semantics instead of cloning the whole update.
- `StageHeartbeatProgress` retains only `StepStats`, hysteresis progress, completion state, and timestamps. It updates scalar/run progress without replacing grid, FEM mesh generation, magnetization, or preview state.
- The existing `CurrentLivePublisher` is the single HTTP publisher. Solver callbacks mutate workspace state and request a publish; the worker performs delta construction, scalar filtering, pending-payload merge, size estimation, cloning, and HTTP after throttling.
- Failed HTTP publication retains destructively-taken FEM mesh and preview payloads for retry.
- Publisher diagnostics name worker costs: workspace-state lock, delta build, pending replacement, payload clone, HTTP, and the successfully published step span.
- Solver-profile JSONL persistence uses `sync_channel(16)` and non-blocking `try_send`. Queue saturation or worker failure disables persistence for the run, exposes `persistence_failed`, and emits one engine error.
- An asynchronous failure while writing the final queued profile sample is immediately reflected in workspace diagnostics without requiring another solver callback.

## Verification evidence

### Local Rust verification

- `CARGO_TARGET_DIR=/tmp/fullmag-task4-target cargo check -p fullmag-cli`: pass. No Task-4-created production dead-code warnings remain. Three unrelated pre-existing runner warnings remain in `artifact_pipeline.rs`, `frequency_response.rs`, and `time_events.rs`.
- `CARGO_TARGET_DIR=/tmp/fullmag-task4-target cargo test -p fullmag-cli`: 227 passed, 0 failed.
- `CARGO_TARGET_DIR=/tmp/fullmag-task4-target cargo test -p fullmag-runner solver_profile --lib`: 17 passed, 0 failed.
- `git diff --check`: pass.

Focused regression coverage includes:

- 250 ms HTTP sink, five callbacks, measured test p95 below 10 ms, one coalesced publication, latest step retained;
- 3,000,000-value field while HTTP is blocked, proving the workspace lock is released before HTTP;
- first HTTP failure followed by successful retry with serialized FEM mesh and preview present;
- bounded profile queue saturation with a non-blocking callback, visible failure, persistence disabled, and one error;
- failure on the final queued profile write becoming visible without a subsequent producer call;
- lightweight heartbeat preserving grid, FEM mesh generation, magnetization, and preview identity.

### Source and managed runtime gates

- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-source-contract`: pass.
  - semantic inventory: 191 `.fem_mesh` accesses and 64 mesh producers;
  - native relaxation, stage-completion, and explicit-RK source contracts built and passed.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: pass on the final frozen source.
  - managed runtime bundle rebuilt and validated;
  - GPU smoke and CPU `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`, and `tangent_plane_implicit` smokes validated;
  - terminal result: `FEM relaxation runtime smoke completed`.

### Five-repeat production performance gate

Command:

```bash
COMPOSE_PROJECT_NAME=fullmag FULLMAG_BENCH_REPEAT=5 just verify-fem-gpu-performance-regression
```

Result: pass, 10/10 rows successful, zero gate/group failures, accepted-baseline comparison passed at the 5% regression limit, CPU/GPU consistency passed, and strict GPU residency passed.

For `box500_airbox_exchange_demag`, nonlinear CG, 64 steps:

| Metric | FEM CPU | FEM GPU | Observation |
|---|---:|---:|---:|
| wall time p50 | 10415.703 ms | 5264.808 ms | about 1.98x CPU/GPU speedup |
| wall time p95 | 10516.263 ms | 5282.710 ms | bounded five-run spread |
| demag apply p50 | 114.742 ms | 53.577 ms | about 2.14x CPU/GPU speedup |
| demag apply p95 | 118.251 ms | 62.652 ms | pass |

Artifacts:

- `.fullmag/reports/fem_gpu_performance_regression.csv`
- `.fullmag/reports/fem_gpu_performance_regression_summary.json`

## Acceptance interpretation and limits

The production regression CSV does not export solver-profile callback or `unprofiled_gap_per_step` columns. Therefore no production p50 gap value is claimed from this gate. The callback deadline is verified by the focused slow-sink tests, while previously unclassified publication work is now explicitly named by `state_lock_wall_time_ns`, `delta_build_wall_time_ns`, `replace_wall_time_ns`, `clone_wall_time_ns`, `http_wall_time_ns`, and the published step-span fields. A future benchmark-schema task should ingest these diagnostics if a production distribution of callback/gap metrics is required.

This task improves orchestration and publication overhead; it does not claim increased instantaneous GPU utilization. The repeat-five evidence establishes no performance regression and an approximately 1.98x end-to-end GPU speedup over the paired CPU run for the accepted fixture.

## Workspace hygiene

The parent-owned `.superpowers/sdd/progress.md` was not edited by this task and is excluded from the Task 4 commit. To recover build space, only ended Task 3 caches were removed: `/tmp/task3-rereview-target`, `/tmp/task3-closure-target`, `/tmp/task3-stage-identity-target`, `/tmp/task3-remediation-target`, `/tmp/task3-review-cli-count`, `/tmp/task3-review-cli`, and `/tmp/task3-review-api`; free space increased from approximately 956 MiB to 31 GiB.
