# Fullmag solver performance audit - CPU/GPU synchronization and async paths

Date: 2026-06-14

Scope: runner orchestration, FDM CPU, FDM CUDA, FEM native CPU/GPU, live Control Room publish path, artifact writing, solver profiler coverage, and known hot host/device synchronization points.

This audit is primarily code-based and now includes managed smoke/medium
benchmark evidence collected through the repository `just` recipes. Production-
scale runtime proof for the user's current large mesh is still open and should
use the managed verification paths listed in the verification plan.

## Implementation status - 2026-06-14

Implemented in the current remediation pass:

- FEM native scalar stats no longer copy full `m` and `H_eff` in `relax_step()` or `snapshot_step_stats()` just to compute torque and average magnetization. Those paths now consume native `max_torque_Apm` and `mx/my/mz` stats.
- A source contract test asserts that the native FEM stats paths do not call `copy_m()`, `copy_h_eff()`, `max_torque_residual_apm_from_field()`, or `apply_average_m_to_step_stats()`.
- `StepStats` and solver-profile samples now expose `field_copy_wall_time_ns`, `field_copy_bytes`, `artifact_enqueue_block_wall_time_ns`, `artifact_enqueue_bytes`, and `artifact_queue_depth_max`.
- Solver-profile samples and Control Room footer diagnostics now expose FEM GPU hot-loop sync/readback counters, including control-scalar sync count and D2H bytes.
- Solver-profile samples and Control Room footer diagnostics now expose whether the demag solver setup was reused for the sampled step.
- Solver-profile samples now expose `delta_wall_time_ns` and `unprofiled_gap_wall_time_ns`; Control Room shows these as `Delta wall` and `Gap`, and engine compact logs include `delta=` and `gap=`.
- Native FEM `step_interruptible()` and direct-minimizer `relax_step()` now measure the whole Rust-to-native FFI call and use it as a lower bound for `StepStats.wall_time_ns`, so backend work omitted from native phase stats is no longer hidden from `Total`.
- Native FEM direct-minimizer profiling now accumulates current-state and trial line-search snapshot timings into the accepted step profile. Rejected Armijo trials no longer disappear into `Missing` while still being counted in `Total`.
- Native FEM direct-minimizer profiling now exposes exchange+mass preconditioner time as a dedicated `relax_preconditioner` phase. Control Room footer diagnostics show it as `Relax prec.`, and compact engine logs include `relax_preconditioner=...`.
- Native FEM direct-minimizer exchange+mass preconditioner now reuses the assembled `mass + weight * exchange` operator when the mass matrix, exchange matrix, dimensions, and effective weight match. Solver-profile samples and compact logs expose preconditioner cache hits/misses.
- Native FEM runner profiling now exposes Rust-measured FFI time not attributed by native phase stats as `native_ffi_overhead_wall_time_ns`. Solver-profile samples publish it as phase `native_ffi_overhead`, and Control Room footer diagnostics show it as `Native`.
- Native FEM direct-minimizer profiling now splits driver work into `relax_state_copy`, `relax_state_upload`, `relax_retraction`, `relax_gradient`, `relax_metric`, `relax_line_search`, and `relax_update`. Control Room folds these into the `Native` column as `copy/upload/ret/grad/metric/ls/upd` so the PGBB hot path is no longer a single opaque block.
- Native FEM direct-minimizer trial-state upload and finiteness validation inside `upload_and_snapshot()` are now timed as `relax_state_upload` and subtracted from residual `native_ffi_overhead`.
- Native FEM direct-minimizer trial snapshots no longer call the public `context_upload_magnetization_f64()` path. PGBB/NCG/TPI now set the internal trial magnetization state directly and let `context_snapshot_stats_mfem()` perform the single timed effective-field refresh, eliminating the hidden first `compute_effective_fields_for_magnetization()` per trial.
- PGBB `update_bb_step_size()` no longer allocates full `s`/`y` vectors and no longer performs three separate mass-metric reductions. It computes `s_dot_s`, `s_dot_y`, and `y_dot_y` in one pass over magnetic nodes.
- PGBB line-search retraction now reuses the existing `trial_m` buffer through `retracted_step_into()` instead of allocating a fresh `std::vector<double>` on every trial/backtrack.
- `FULLMAG_CPU_THREADS=auto` no longer caps active FEM demag/Poisson runs to the small/medium mesh OpenMP cap. The cap remains available for non-demag CPU work where small-loop OpenMP overhead is the concern.
- Native FEM step stats, solver-profile JSON, OpenAPI, generated Control Room types, and footer diagnostics now expose the CPU thread-cap reason (`auto-small-mesh-cap`, `auto-medium-mesh-cap`, `auto-uncapped`, etc.).
- The footer profiler no longer labels demag setup as `built` when setup wall time is zero and reuse data is absent; `built` is reserved for a nonzero setup phase.
- The Control Room solver-profiler command now enables `persist_artifact` when profiling is enabled, so new profiler sessions write `diagnostics/solver_profile.jsonl` instead of relying only on the live ring buffer.
- FDM CUDA native step stats now carry hot-loop control-scalar D2H byte counts and host-sync counts from the CUDA reduction/readback boundary into `StepStats`, so the existing solver-profile/UI GPU-sync column also covers FDM CUDA adaptive scalar readbacks.
- FEM live relaxation paths measure synchronous magnetization payload copies and attach those costs to step stats.
- `ArtifactRecorder` now measures bounded-channel enqueue wait time and approximate queue depth for artifact jobs.
- `ArtifactPipelineSummary` and artifact `metadata.json` now expose writer-side artifact job timing: total writer job wall time and split scalar/field/native-snapshot write time.
- Solver-profile samples now mirror live artifact writer diagnostics: current/max queue depth, completed writer job count, total writer job wall time, and scalar/field/native-snapshot writer splits.
- Live publisher diagnostics are now structured in the solver-profile resource: replace count/time, merge time, clone time, publish sync time, publish lag, coalesced wake count, disconnected wake count, and approximate payload bytes.
- Control Room footer diagnostics now show wall-clock sample time, wall-clock delta, preview/cache/field-copy/orchestration/native phases, and artifact enqueue cost including payload size, queue depth, writer job count, and writer job wall time.
- Control Room footer diagnostics now show live publisher summary telemetry without adding a polling loop.
- End-of-stage FEM finalization now records `finalization_wall_time_ns`, `finalization_field_copy_wall_time_ns`, and `finalization_field_copy_bytes` into the last step sample; solver-profile/OpenAPI/Control Room show this as a `Finalization` phase. The orchestrator force-records the completion sample so wall-clock sampling cannot hide end-of-stage finalization.
- Native FEM torque preview now uses a native `FULLMAG_FEM_OBSERVABLE_TORQUE` field copy instead of Rust-side `copy_m()` plus `copy_h_eff()` plus `compute_torque_field()`. CPU torque preview is computed directly from native buffers; GPU torque preview is still synchronous but returns one torque payload to Rust instead of two full source fields.
- Native FEM host-only magnetization upload no longer attempts GPU effective-field uploads when the GPU runtime state is not allocated. This fixes a state-I/O contract crash and avoids invalid host/GPU synchronization on CPU-only contexts.
- Control Room footer profiler now shows demag solve count, Poisson iteration count, final residual, and demag solver apply time next to the total demag phase, so demag-dominated rows can be diagnosed without opening raw JSON.
- Native FEM live preview loops no longer print per-preview debug diagnostics from the solver hot path; a source contract test prevents the `native-fem live update` log from returning.
- Native FEM active-preview copies are now centralized behind `fem/relax/preview.rs::build_fem_live_preview_field()`. Direct-minimizer and LLG relaxation loops no longer call `backend.copy_live_preview_field()` directly, so the remaining native async snapshot ABI can replace one boundary instead of multiple solver loops.
- Native FEM now exposes field/preview snapshot begin/wait/destroy ABI entrypoints, and active live preview routes through `begin_live_preview_snapshot().into_live_preview_field()` instead of the direct synchronous preview-copy helper.
- Native FEM GPU-backed field/preview snapshot ABI now stages payloads through private device buffers and pinned host AoS storage on a CUDA snapshot stream. CPU-only and host-only observables keep the same ABI with synchronous host fallback.
- Native FEM relaxation field snapshots now route through `begin_field_snapshot().into_vector_field()` instead of direct `copy_m()` / `copy_h_*()` helper dispatch.
- Native FEM live magnetization payloads and final magnetization output now use the same field snapshot boundary instead of direct `backend.copy_m(...)` calls in the relaxation modules.
- Streaming native FEM scheduled field snapshots now enqueue pending `NativeFemFieldSnapshot` handles to the artifact writer thread. The writer waits on the native snapshot, writes the Zarr payload, and records the time under the existing native-snapshot writer diagnostics. In-memory runs keep the materialized `FieldSnapshot` fallback.
- Native FEM preview snapshots now expose a nonblocking `fullmag_fem_preview_snapshot_ready` ABI. Active LLG/direct-minimizer live preview uses `FemLivePreviewHandoff` to poll pending snapshots and publish a completed/last-good preview instead of immediately waiting on `begin_live_preview_snapshot().into_live_preview_field()`.
- Native FEM field snapshots now expose a nonblocking `fullmag_fem_field_snapshot_ready` ABI. Active LLG/direct-minimizer live magnetization payloads use `FemLiveMagnetizationHandoff` to start a magnetization snapshot, poll readiness, and publish only completed payloads instead of immediately waiting in the solver loop.
- Native FEM CPU direct minimizers now cache the accepted `trial_stats` as the next step's current snapshot, with timing/solve counters cleared. PGBB/NCG/TPI reuse that current snapshot when the cached step/time matches the context, avoiding one redundant Poisson demag solve at the start of the next accepted step.
- `FULLMAG_DISABLE_PREVIEW_3D=1` now acts as a solver benchmark preview-off mode before runner payload construction: the CLI sets `field_every_n = u64::MAX`, disables initial 3D snapshots, and the runner/hysteresis live paths translate that cadence into `display_selection: None` so active/cached preview builders are not invoked.
- Solver-profile snapshots and the v2 diagnostics schema now carry `preview_3d_disabled`; Control Room footer diagnostics label benchmark samples as "3D preview disabled for benchmark" when `FULLMAG_DISABLE_PREVIEW_3D=1` is active.
- Managed FEM runtime export now uses `install -m 755` for launcher/API binaries instead of a bind-mount-fragile temporary copy/move path, so `just ensure-managed-fem-runtime` can complete after ABI/runtime changes.
- `verify-fem-relaxation-source-contract` now runs through the FEM GPU container path instead of reusing a host-side `native/build` cache.

Verified:

- `cargo check -p fullmag-runner --features fem-gpu`
- `cargo check -p fullmag-runner --features cuda,fem-gpu`
- `cargo check -p fullmag-api`
- `cargo test -p fullmag-runner native_fem_runner_stats_paths_do_not_copy_full_fields_for_scalar_metrics --features fem-gpu`
- `cargo test -p fullmag-runner native_fem_runner_step_total_covers_full_ffi_call_wall_time --features fem-gpu`
- `cargo test -p fullmag-runner solver_profile_ring_buffer_keeps_latest_samples_and_phase_math --features fem-gpu`
- `cargo test -p fullmag-runner metadata_persists_artifact_pipeline_writer_timing --features fem-gpu`
- `cargo test -p fullmag-runner metadata_persists_artifact_pipeline_writer_timing --features cuda,fem-gpu`
- `pnpm --dir apps/control-room test -- FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner solver_profile_ring_buffer_keeps_latest_samples_and_phase_math --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-api`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target pnpm --dir apps/control-room generate:api`
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner fem_live_preview_hot_path_has_no_debug_logging --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner fem_relaxation_preview_copy_is_centralized --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo fmt --check -p fullmag-runner`
- `just verify-fem-relaxation-source-contract`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-fdm-sys step_stats_abi_carries_hot_loop_scalar_readback_audit`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features cuda,fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner native_fem_runner_step_total_covers_full_ffi_call_wall_time --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-cli --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo fmt --check -p fullmag-runner -p fullmag-api -p fullmag-fem-sys -p fullmag-quantities -p fullmag-cli`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-fem-sys demag_profile_abi_has_timing_fields`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner solver_profile_ring_buffer_keeps_latest_samples_and_phase_math --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-api`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target pnpm --dir apps/control-room generate:api`
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room test -- studyRuntimeCommandContributions.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-cli --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-api`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-cli live_publisher_records_replace_payload_and_coalesced_wake_diagnostics --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target pnpm --dir apps/control-room generate:api`
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-api`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner solver_profile_ring_buffer_keeps_latest_samples_and_phase_math --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo fmt --check -p fullmag-runner -p fullmag-api -p fullmag-quantities`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target pnpm --dir apps/control-room generate:api`
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner solver_profile_force_record_keeps_completion_finalization_visible --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-cli --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo fmt --check -p fullmag-runner -p fullmag-api -p fullmag-quantities -p fullmag-cli`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-api`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner native_fem_torque_preview_uses_native_observable --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-fem-sys observable_enum_has_13_variants`
- container `fem_state_io_contract`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo fmt --check -p fullmag-runner -p fullmag-fem-sys -p fullmag-cli -p fullmag-api -p fullmag-quantities`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-cli --features fem-gpu`
- `just ensure-managed-fem-runtime`
- `just ensure-managed-fem-runtime`
- `just verify-fem-relaxation-source-contract`
- container `fem_cpu_threads_contract`
- container `fem_step_metrics_contract`
- `just verify-fem-relaxation-runtime`
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `just ensure-managed-fem-runtime`
- `env FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb FULLMAG_BENCH_SCENARIOS=box500_airbox_exchange_demag FULLMAG_BENCH_DEMAG_PRECONDITIONERS=AMG,JACOBI,NONE FULLMAG_BENCH_STEPS=2 FULLMAG_BENCH_CASE_TIMEOUT_S=240 FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP=0.01 FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS=999999 FULLMAG_BENCH_MIN_SOLVER_NODES=50 FULLMAG_BENCH_OUTPUT=.fullmag/reports/pgbb_demag_policy_smoke.csv FULLMAG_BENCH_SUMMARY=.fullmag/reports/pgbb_demag_policy_smoke_summary.json just verify-fem-gpu-demag-performance-benchmark` ran the managed runtime and wrote the CSV/JSON policy-smoke artifacts. The recipe exited non-zero because `CG/NONE` did not complete, but the completed `AMG`/`JACOBI` rows are valid for policy comparison.
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts` after the footer-policy display change.
- `cargo fmt --check -p fullmag-runner`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner unresolved_gpu_demag_policy --features fem-gpu`
- `just ensure-managed-fem-runtime` rebuilt the managed FEM runtime bundle after `crates/fullmag-runner/src/native_fem/plan.rs` changed.
- `env FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb FULLMAG_BENCH_SCENARIOS=box500_airbox_exchange_demag FULLMAG_BENCH_DEMAG_PRECONDITIONERS=OMIT FULLMAG_BENCH_STEPS=2 FULLMAG_BENCH_CASE_TIMEOUT_S=240 FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP=0.01 FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS=999999 FULLMAG_BENCH_MIN_SOLVER_NODES=50 FULLMAG_BENCH_OUTPUT=.fullmag/reports/pgbb_demag_policy_omit_smoke.csv FULLMAG_BENCH_SUMMARY=.fullmag/reports/pgbb_demag_policy_omit_smoke_summary.json just verify-fem-gpu-demag-performance-benchmark` ran managed CPU/GPU PGBB rows with an omitted demag preconditioner. The recipe exited non-zero only because `--require-best-demag-policy` requires at least two converged policies; the CSV rows are `ok` and show `requested_demag_preconditioner=OMIT`, resolved `demag_preconditioner=AMG` for both CPU and GPU.
- `python3 -m py_compile scripts/analysis/fem_gpu_benchmark.py scripts/test_validate_fem_relaxation_runtime_log.py`
- `python3 -m pytest scripts/test_validate_fem_relaxation_runtime_log.py`
- `python3 -m py_compile scripts/analysis/fem_gpu_benchmark.py scripts/test_validate_fem_relaxation_runtime_log.py`
- `python3 -m pytest scripts/test_validate_fem_relaxation_runtime_log.py`
- `just --summary`
- `just ensure-managed-fem-runtime`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner native_fem_preview_snapshot_wrapper_uses_abi_begin_wait_destroy --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner fem_relaxation_preview_copy_is_centralized --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner native_fem_snapshot_abi_stages_gpu_payloads_async --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner native_fem_field_snapshot_wrapper_uses_abi_begin_wait_destroy --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner fem_field_snapshot_helpers_are_owned_by_fem_relax_module --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner fem_relaxation_magnetization_payloads_use_snapshot_boundary --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner fem_streaming_field_snapshots_are_writer_owned --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner fem_live_preview_uses_nonblocking_last_good_handoff --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner native_fem_preview_snapshot_wrapper_uses_abi_begin_wait_destroy --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner preview_disabled_live_runner_does_not_pass_display_selection --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-cli disable_preview_3d_disables_runner_preview_inputs --features fem-gpu`
- `rustfmt --check crates/fullmag-runner/src/solver_profile.rs crates/fullmag-cli/src/live_workspace.rs crates/fullmag-api/src/schemas/diagnostics.rs`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-api`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-cli --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo run -p fullmag-api -- --print-openapi-v2 > /tmp/fullmag-openapi-v2.json`
- `pnpm --dir apps/control-room run generate:api-v2-types`
- `pnpm --dir apps/control-room run generate:api-v2-client`
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo test -p fullmag-runner preview_disabled_live_runner_does_not_pass_display_selection --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo test -p fullmag-cli disable_preview_3d_disables_runner_preview_inputs --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo test -p fullmag-runner fem_live_preview_uses_nonblocking_last_good_handoff --features fem-gpu`
- `just ensure-managed-fem-runtime`
- `rustfmt --check crates/fullmag-runner/src/fem/relax/preview.rs crates/fullmag-runner/src/fem/relax/direct_minimizer.rs crates/fullmag-runner/src/fem/relax/llg_overdamped.rs crates/fullmag-runner/src/native_fem.rs crates/fullmag-runner/src/lib.rs crates/fullmag-fem-sys/src/lib.rs`
- `just ensure-managed-fem-runtime`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo test -p fullmag-runner fem_live_magnetization_uses_nonblocking_snapshot_handoff --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo test -p fullmag-runner native_fem_field_snapshot_wrapper_uses_abi_begin_wait_destroy --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo check -p fullmag-runner --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner --features cuda,fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-cli --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner metadata_persists_artifact_pipeline_writer_timing --features cuda,fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo fmt --check -p fullmag-runner -p fullmag-fem-sys`
- `just ensure-managed-fem-runtime`
- `just verify-fem-relaxation-source-contract`
- `bash -n scripts/export_fem_gpu_runtime.sh`
- `bash -n .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu`
- `just ensure-managed-fem-runtime`
- `just verify-fem-relaxation-source-contract`
- `rustfmt --check crates/fullmag-runner/src/interactive_runtime.rs crates/fullmag-runner/src/lib.rs crates/fullmag-runner/src/fem/relax/preview.rs crates/fullmag-runner/src/fem/relax/direct_minimizer.rs crates/fullmag-runner/src/fem/relax/llg_overdamped.rs`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo test -p fullmag-runner fem_cached_preview_helpers_are_owned_by_fem_relax_module --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo test -p fullmag-runner interactive_fem_gpu_runtime_normalizes_native_gpu_plan --features fem-gpu`
- `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-fuse-ld=bfd' cargo check -p fullmag-runner --features fem-gpu`
- `rustfmt --check crates/fullmag-runner/src/types.rs crates/fullmag-runner/src/solver_profile.rs crates/fullmag-runner/src/native_fem.rs crates/fullmag-api/src/schemas/diagnostics.rs`
- `cargo test -p fullmag-runner solver_profile_ring_buffer_keeps_latest_samples_and_phase_math --features fem-gpu`
- `cargo check -p fullmag-runner --features fem-gpu`
- `cargo check -p fullmag-api`
- `cargo run -p fullmag-api -- --print-openapi-v2 > /tmp/fullmag-openapi-v2.json`
- `pnpm --dir apps/control-room run generate:api-v2-types`
- `pnpm --dir apps/control-room run generate:api-v2-client`
- `pnpm --dir apps/control-room exec vitest run src/modules/footer/FooterDiagnostics.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `just ensure-managed-fem-runtime`
- `just ensure-managed-fem-runtime` on 2026-06-15 after the
  `crates/fullmag-runner/src/native_fem.rs` source-contract update. The managed
  recipe detected the bundle was stale because of `native_fem.rs`, rebuilt the
  release `fullmag-cli`/`fullmag-api` artifacts inside the FEM GPU container,
  completed `export_fem_gpu_runtime.sh`, and produced
  `.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu` plus
  `.fullmag/runtimes/fem-gpu-host/manifest.json` with runtime
  `fem-gpu-host` and docker image id
  `sha256:b28210623cbd3ee15a2359ee5f013d262b5ccb65d3f9a93bddad6c196606bf12`.
- `just ensure-managed-fem-runtime` on 2026-06-15 after adding
  `fullmag_fem_backend_average_m_for_nodes_f64`. The managed recipe rebuilt the
  runtime bundle successfully; `nm -D
  .fullmag/runtimes/fem-gpu-host/lib/libfullmag_fem.so` shows the exported
  symbol `fullmag_fem_backend_average_m_for_nodes_f64`.
- `rustfmt --check crates/fullmag-runner/src/native_fem.rs
  crates/fullmag-fem-sys/src/lib.rs`
- `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner
  native_fem_per_object_average_m_uses_native_node_reduction --features
  fem-gpu`
- `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner
  native_fem_runner_stats_paths_do_not_copy_full_fields_for_scalar_metrics
  --features fem-gpu`
- `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo check -p fullmag-runner
  --features fem-gpu`
- `just verify-fem-relaxation-source-contract` after the native per-object
  average ABI change; the container build compiled `backends/fem/src/api.cpp`,
  linked `libfullmag_fem.so`, built `fem_relaxation_source_contract`, and the
  recipe exited successfully.
- `git diff --check -- native/include/fullmag_fem.h
  crates/fullmag-fem-sys/src/lib.rs backends/fem/src/api.cpp
  crates/fullmag-runner/src/native_fem.rs
  docs/performance/solver-performance-audit-2026-06-14.md`

Still open from the audit:

- Demag Poisson solve count is now visible and avoidable duplicate current-state solves have been removed for direct minimizers, but the latest samples show the remaining bottleneck is a single Hypre apply: typical accepted steps now report `1 solve`, yet `demag_solver_apply` can still take 5-15 s. This is now a linear-solver/preconditioner/runtime scaling problem, not a hidden runner/orchestration problem.
- Interactive FEM GPU runtime now normalizes unresolved GPU plans through the same `mfem_device_string` resolution as batch execution. This prevents GPU interactive runs from creating native backends from unresolved `plan.clone()` state, but the next runtime proof should confirm the live log reports the intended `mfem_device` and demag preconditioner.
- Native FEM step stats, solver-profile JSON, OpenAPI, generated Control Room types, compact engine logs, and footer diagnostics now expose the resolved demag solver/preconditioner policy. Fresh rows should show details such as `CG/JACOBI / 1 solve / ...` or `CG/AMG / ...`, which separates policy regressions from raw linear-solve cost.
- Managed FEM benchmark gates now expose demag apply-time, iteration-count, and setup-reuse budgets without requiring an accepted baseline CSV. `scripts/analysis/fem_gpu_benchmark.py` supports `--max-demag-solver-apply-ms` and `--require-demag-setup-reused`; the production and demag-performance `just` recipes wire apply time through `FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS`, wire iteration count through `FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS`, and fail multi-step demag rows that do not prove warmed solver setup reuse.
- Benchmark pass/fail summaries now include concrete failure reasons, not only
  failure counts. Human/Markdown reports therefore preserve demag setup-reuse
  gate failures and solver-mesh group failures without requiring the raw
  console log.
- `verify-fem-gpu-demag-performance-benchmark` now includes `projected_gradient_bb` in its default relaxation-algorithm coverage and applies the PGBB GPU control-readback budget. This closes a benchmark coverage gap for the user's primary relaxation algorithm.
- A managed PGBB demag-policy smoke was run with
  `FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb`,
  `FULLMAG_BENCH_SCENARIOS=box500_airbox_exchange_demag`,
  `FULLMAG_BENCH_DEMAG_PRECONDITIONERS=AMG,JACOBI,NONE`,
  `FULLMAG_BENCH_STEPS=2`, and outputs at
  `.fullmag/reports/pgbb_demag_policy_smoke.csv` /
  `.fullmag/reports/pgbb_demag_policy_smoke_summary.json`. It produced
  four completed rows and two expected `CG/NONE` failures. For this small
  smoke, CPU selected `CG/JACOBI` (`demag_solver_apply_wall_time_ms` about
  4.1 ms, 72 iterations), while strict GPU selected `CG/AMG` (about 60 ms,
  25 iterations). Explicit `CG/JACOBI` on strict GPU was slower in apply time
  (about 85 ms, 72 iterations). This is not yet enough to globally replace the
  documented warmed strict-GPU default, but it is strong evidence that the
  user's PGBB demag path must be policy-swept on the real mesh before assuming
  `JACOBI` is optimal.
- The unresolved strict GPU runtime policy is now algorithm-aware: explicit
  user policies are still preserved, non-PGBB strict GPU plans keep the
  documented `CG/JACOBI` fallback, and strict GPU `projected_gradient_bb` plans
  resolve an omitted demag policy to `CG/AMG`. The next live PGBB run should
  therefore show `CG/AMG / 1 solve / ...` in `Demag detail` after rebuilding the
  managed runtime bundle.
- The managed `OMIT` smoke after rebuilding the runtime bundle confirms the
  resolved policy in runtime output: both CPU and strict GPU PGBB rows requested
  `OMIT` and reported resolved `AMG`; the strict GPU row completed with 25
  Poisson iterations and `demag_solver_apply_wall_time_ms` about 42.9 ms on the
  coarse Box500 smoke.
- The demag performance benchmark can now sweep solver tolerance through
  `--demag-rtols` / `FULLMAG_BENCH_DEMAG_RTOLS`. This is needed because the
  problematic live rows converge to residuals around `1e-8`, while existing
  demag benchmark examples often use `1e-6`. When
  `--demag-convergence-residual` is not explicitly set, the convergence gate now
  uses each row's requested demag rtol instead of one global threshold, so mixed
  `1e-8,1e-6` sweeps remain meaningful.
- Best-policy selection now takes an explicit timing metric through
  `--best-demag-policy-metric` / `FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC`.
  The production and demag-performance recipes default it to
  `demag_solver_apply_wall_time_ms`, which matches the current live bottleneck
  instead of relying on whichever broad demag timing field happens to be first
  in the CSV row.
- Artifact `demag_runtime` metadata and benchmark CSV rows now distinguish
  requested demag policy from resolved runtime policy. `policy_source` is
  `explicit` when the user provided `study.fem_demag_solver(...)` and
  `resolved_default` when the runtime selected the default policy. The metadata
  also carries `requested_linear_solver`, `requested_preconditioner`,
  `requested_relative_tolerance`, `requested_absolute_tolerance`,
  `requested_max_iterations`, and `requested_print_level` alongside the
  resolved `linear_solver` / `preconditioner` / tolerance fields. This prevents
  future performance reports from confusing a user-selected policy with a
  runtime default.
- `demag_runtime` also records the concrete MFEM/Hypre BoomerAMG profile when
  the resolved preconditioner is `AMG`: provider `mfem_hypre_boomeramg`,
  `relax_type=18`, `coarsening=8`, `interpolation=6`, and
  `aggressive_coarsening=1`. Benchmark CSV rows expose the same values as
  `demag_amg_*` columns. Source-contract coverage ties these metadata values to
  the native CPU and GPU demag solver setup code, so future Hypre tuning cannot
  silently change the runtime configuration without changing the recorded
  profile.
- Native CPU and strict GPU Poisson demag can now sweep the BoomerAMG profile
  through benchmark/runtime environment variables:
  `FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE`,
  `FULLMAG_FEM_DEMAG_AMG_COARSENING`,
  `FULLMAG_FEM_DEMAG_AMG_INTERPOLATION`, and
  `FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING`. Optional expert overrides
  `FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD` and
  `FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS` are applied only when set, preserving the
  current MFEM/Hypre defaults otherwise. The managed production and
  demag-performance recipes expose these as
  `FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES`,
  `FULLMAG_BENCH_DEMAG_AMG_COARSENINGS`,
  `FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS`, and
  `FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS`, plus optional
  `FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS` and
  `FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS`, while keeping the current `18/8/6/1`
  core profile as the default. Best-policy summaries distinguish these profile
  values, so large-model Hypre apply tuning can compare AMG profiles without
  conflating them into one policy row.
- `just bench-fem-gpu-demag-amg-profile-sweep` is now the managed exploratory
  entrypoint for BoomerAMG profile tuning. It writes CSV, JSON, Markdown, and
  `FEM_BEST_DEMAG_POLICY` rows while leaving the production
  `verify-fem-gpu-demag-performance-benchmark` gates strict. This lets an AMG
  variant fail convergence or residual telemetry during tuning without
  weakening the production proof path that still requires convergence,
  setup-reuse, CPU/GPU consistency, strict GPU residency, and best-policy
  gates.
- The demag-performance and AMG-profile managed recipes now accept
  `FULLMAG_BENCH_MESHES`; the default remains `coarse`, but the same
  container-backed workflow can now be run against `medium`, `fine`, or an
  explicit `.mesh.json` path. This removes the previous need to hand-edit the
  justfile or bypass the managed recipe before collecting large-model demag
  policy data.
- A managed smoke of the mesh-selectable AMG profile target with
  `FULLMAG_BENCH_MESHES=coarse` wrote
  `.fullmag/reports/amg_mesh_env_smoke.*` and exited successfully. The command
  line inside the container used `--meshes "$FULLMAG_BENCH_MESHES"`, proving the
  justfile no longer hardcodes `coarse` at the demag-policy sweep boundary.
- A managed smoke of `just bench-fem-gpu-demag-amg-profile-sweep` with AMG
  profiles `18/8/6/1` and `6/8/6/1`, PGBB, two steps, and outputs at
  `.fullmag/reports/amg_profile_sweep_recipe_smoke.*` exited successfully and
  wrote four `ok` runtime rows. The report status remains `fail` because the
  experimental CPU `relax_type=6` row did not report a demag residual and
  therefore fails the solver-mesh group summary; that is intentional for an
  exploratory sweep and is not accepted by the strict verification recipe.
  The completed rows show CPU profile 18 at 25 iterations / 5.8 ms apply,
  GPU profile 18 at 23 iterations / 37.2 ms apply, CPU profile 6 at
  1 iteration / 1.1 ms apply with missing residual telemetry, and GPU profile 6
  at 14 iterations / 46.6 ms apply.
- A managed smoke of the same exploratory recipe with
  `FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS=default,0.25` and outputs at
  `.fullmag/reports/amg_strength_sweep_smoke.*` exited successfully. The CSV
  records both requested and resolved `demag_amg_strength_threshold` columns:
  the default rows leave them empty, while the override rows report `0.25`.
  All four rows converged in this coarse smoke; GPU apply time was about
  44.4 ms for the default strength threshold and 41.8 ms for `0.25`. This is
  not a production policy change, but it proves the large-model tuning harness
  can now sweep and record this Hypre AMG parameter.
- A managed PGBB demag rtol/policy smoke completed with
  `FULLMAG_BENCH_DEMAG_PRECONDITIONERS=AMG,JACOBI`,
  `FULLMAG_BENCH_DEMAG_RTOLS=1e-8,1e-6`, and outputs at
  `.fullmag/reports/pgbb_demag_rtol_policy_smoke.csv` /
  `.fullmag/reports/pgbb_demag_rtol_policy_smoke_summary.json`. All 8 rows
  passed. On the coarse Box500 smoke, explicit `CG/JACOBI` was faster than
  explicit `CG/AMG` despite more iterations: strict GPU `1e-8` was 72
  iterations / 23.3 ms for `JACOBI` versus 25 iterations / 49.4 ms for `AMG`;
  strict GPU `1e-6` was 54 iterations / 17.7 ms for `JACOBI` versus 18
  iterations / 33.0 ms for `AMG`. Lowering rtol from `1e-8` to `1e-6` reduced
  strict-GPU `JACOBI` apply time by about 24% on this smoke. This does not yet
  prove the real large-mesh optimum, but it proves the benchmark can now expose
  the preconditioner/tolerance tradeoff needed for the user's PGBB workload.
- A managed medium-mesh exploratory sweep completed through
  `just bench-fem-gpu-demag-amg-profile-sweep` with
  `FULLMAG_BENCH_MESHES=medium`,
  `FULLMAG_BENCH_DEMAG_PRECONDITIONERS=AMG,JACOBI`,
  `FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS=default,0.25`,
  `FULLMAG_BENCH_DEMAG_RTOLS=1e-8`, and outputs at
  `.fullmag/reports/amg_medium_policy_sweep.*`. All 6 runtime rows were `ok`.
  The raw rows show useful timing evidence but also expose a benchmark design
  issue: the airbox/shared-domain solver mesh is regenerated per policy row.
  On the nominal 1395-node / 4599-element medium input, completed solver rows
  ranged from 1197 to 1218 nodes and from 5092 to 5213 elements. Raw apply
  times were CPU `JACOBI` 70 iterations / 3.12 ms versus CPU default-strength
  `AMG` 26 iterations / 5.74 ms, and strict GPU `JACOBI` 65 iterations /
  19.43 ms versus strict GPU default-strength `AMG` 24 iterations / 41.04 ms.
  The AMG strength-threshold override `0.25` converged but did not improve the
  raw medium rows: CPU 25 iterations / 6.49 ms, strict GPU 27 iterations /
  44.45 ms. This is not a valid best-policy proof because each policy/profile
  row used a different `solver_mesh_signature`; the human report therefore
  correctly marks CPU/GPU consistency as failed for this exploratory sweep.
- Best-demag-policy selection now refuses to choose a winner when a logical
  policy-selection case contains multiple `solver_mesh_signature` values. The
  existing `.fullmag/reports/amg_medium_policy_sweep.csv` now yields no
  `FEM_BEST_DEMAG_POLICY` rows and reports explicit failures for CPU and GPU:
  each cannot select a best policy because policy rows used 3 solver mesh
  signatures. This prevents generated-mesh variance from being mistaken for a
  solver/preconditioner performance result.
- The benchmark harness can now materialize a generated shared-domain mesh once
  and reuse it as an explicit domain mesh across policy/backend rows through
  `--reuse-generated-domain-mesh`. `examples/bench_fem_gpu_long.py` supports
  `FULLMAG_BENCH_EXPORT_DOMAIN_MESH` for one-shot domain-mesh export and
  `FULLMAG_BENCH_DOMAIN_MESH` for explicit shared-domain reuse. Managed
  production, demag-performance, and AMG-profile sweep recipes pass the reuse
  flag. A local export smoke produced a 1216-node / 5183-element mesh with
  magnetic+air markers `[0, 1]`.
- A managed reuse-domain-mesh smoke then completed through
  `just bench-fem-gpu-demag-amg-profile-sweep` with coarse
  `box500_airbox_exchange_demag`, `projected_gradient_bb`, `AMG,JACOBI`, and
  outputs at `.fullmag/reports/reuse_domain_mesh_smoke.*`. All 4 CPU/GPU rows
  passed, all rows used the same `solver_mesh_signature`
  `5ba17d1cadec12cff521b56f77f7f3088f06e6da61f01e436ac9d935969000e1`, and
  both JSON and markdown artifacts now preserve the selected best policy. On
  this coarse comparable smoke, best policy was `CG/JACOBI` for CPU
  (3.769 ms average solver apply) and strict GPU (25.99 ms average solver
  apply). This replaces stdout-only best-policy evidence with durable
  benchmark artifacts, but it is still a coarse smoke rather than the final
  medium/large-model policy decision.
- The managed medium-mesh sweep was rerun with `--reuse-generated-domain-mesh`
  and outputs at `.fullmag/reports/amg_medium_policy_sweep_reuse.*`. All 6
  CPU/GPU rows passed, every row used the same 1207-node / 5177-element solver
  mesh with signature
  `c2135a6b923ed7f05eefe40344c15ad18a6a0914c91c96059926a127e4e11641`, and
  both summary artifacts preserve `best_demag_policy`. On this comparable
  medium run, `CG/JACOBI` was still the fastest accepted policy for CPU and
  strict GPU despite more iterations: CPU `JACOBI` 73 iterations / 3.20 ms
  solver apply versus CPU `AMG` 28 iterations / 6.83 ms default strength and
  6.31 ms at strength threshold `0.25`; strict GPU `JACOBI` 73 iterations /
  23.48 ms solver apply versus strict GPU `AMG` 27 iterations / 45.77 ms
  default strength and 48.45 ms at strength threshold `0.25`. This is now a
  valid comparable medium policy result; the user's current large model still
  needs the same reuse-domain-mesh sweep before making a production default
  change.
- The largest repository mesh preset, `fine`
  (`examples/assets/bench_box_fine.mesh.json`, nominal 4985 nodes / 19835
  elements), was also swept through the same managed reuse-domain-mesh path
  with outputs at `.fullmag/reports/amg_fine_policy_sweep_reuse.*`. All 6 rows
  passed on the same 1209-node / 5164-element solver mesh with signature
  `83bf5cd751a9a33f2ebc0396e9e498f12f9851be740507f3bdbc381c6bee468d`.
  `CG/JACOBI` remained the fastest accepted policy: CPU 67 iterations /
  3.45 ms solver apply versus CPU `AMG` 25 iterations / 4.73 ms default
  strength and 5.91 ms at strength threshold `0.25`; strict GPU `JACOBI`
  67 iterations / 21.36 ms solver apply versus strict GPU `AMG`
  25 iterations / 47.35 ms default strength and 41.68 ms at strength
  threshold `0.25`.
- Accepted-baseline regression now has a comparable generated-mesh path:
  `scripts/analysis/fem_gpu_benchmark.py` accepts
  `--generated-domain-mesh-cache-dir`, and managed recipes expose it through
  `FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR`. The performance-regression case key
  now normalizes in-memory numeric values and CSV string values before
  comparison. A managed two-run proof with
  `.fullmag/reports/persistent_cache_baseline.csv` and
  `.fullmag/reports/persistent_cache_baseline_check.csv` reused
  `.fullmag/reports/domain_mesh_cache/86efbebbc3b8.domain.mesh.json`,
  reported `FEM_ACCEPTED_BASELINE` with `comparable_case_count=4`, and passed
  `--require-accepted-baseline`. This proves the gate mechanics; choosing a
  committed or archived baseline still needs a controlled-machine policy.

Fresh runtime interpretation from the latest user sample:

- Steps 3-7 usually report `1 solve`, so the previous duplicate-current-snapshot problem is not back. Step 2 still reports `4 solve`, which is consistent with extra trial/backtrack/finalization work early in the relaxation.
- The accepted-step bottleneck is now the single demag apply itself: examples include step 4 `1 solve / 29 it / apply 4.95 s`, step 6 `1 solve / 24 it / apply 10.08 s`, and step 7 `1 solve / 35 it / apply 14.73 s`.
- The later pre-`CG/AMG` live sample repeated the same pattern: steps 9-15 report
  `1 solve`, setup reuse, `Missing=0`, 39-49 Poisson iterations, and
  `demag_solver_apply` between 12.50 s and 20.37 s. Representative rows:
  step 10 `1 solve / 49 it / apply 20.37 s`, step 14
  `1 solve / 39 it / apply 14.26 s`, step 15
  `1 solve / 46 it / apply 13.17 s`. `Exchange`, `Relax prec.`, `RHS`,
  `Native`, `Orchestr.`, `Artifact`, and `Field copy` are not material in this
  sample. This confirms the active issue is not repeated setup, not duplicate
  current-state solve, and not runner/UI/artifact overhead.
- A later live sample after `CG/AMG` policy visibility shows material
  improvement without weakening convergence: steps 8-13 report `CG/AMG`,
  `1 solve`, setup reuse, `Missing=0`, 17-22 Poisson iterations, residuals
  around `6e-9` to `8e-9`, and `demag_solver_apply` between 7.18 s and
  8.63 s. This is still demag-dominated, but it is no longer the earlier
  39-49 iteration / 12.50-20.37 s regime.
- If Control Room rows still show `1 solve / ...` without the `CG/JACOBI` or `CG/AMG` prefix, that frontend/runtime session predates the latest diagnostics schema/runtime bundle or needs a refresh/restart.
- That means the urgent remaining work is Hypre/MFEM demag policy and scaling: preconditioner choice, tolerance policy, OpenMP/MPI/runtime threading, and mesh conditioning. Runner orchestration, preview, artifact enqueue, field copy, and native missing time are no longer the dominant terms in this sample.

## Executive summary

Fullmag already has several correct performance foundations:

- artifact writing is a dedicated bounded writer thread, not unbounded in-memory accumulation;
- live Control Room publishing is coalesced on a separate publisher thread;
- FDM CUDA has asynchronous field/preview snapshot APIs using device staging, pinned host memory, and a dedicated snapshot/preview stream;
- FEM native step stats expose demag subphases: assemble, solve, solver setup/apply, recover, and energy;
- FEM CUDA has transfer-audit counters for device-host traffic, including special handling for hot-loop control-scalar readbacks;
- interactive runtime has cadence gates for active preview and cached preview, and FDM GPU persistent mode can prefetch cached preview snapshots.

The main performance risks are not from missing threads in general. They are from synchronous payload preparation and host/device synchronization at the solver boundary:

1. FEM native scalar stats no longer copy full `m` and full `H_eff` to host for torque and averages in the runner. This P0 finding was fixed in the current remediation pass. Remaining FEM field copies are live preview, field save, inspection, and user-visible payload paths.
2. FEM heavy magnetization payloads are no longer direct synchronous field-copy calls in the relaxation modules. GPU-backed native field/preview snapshot ABI now stages through private device buffers, pinned host memory, and a CUDA snapshot stream. Active preview, cached preview, relaxation field snapshots, live magnetization payloads, and final magnetization output use the begin/wait/destroy ABI. Active live preview, cached preview, and live magnetization payloads now poll readiness through handoff state instead of immediately waiting; streaming scheduled field snapshots are handed to the artifact writer before wait/write. `FULLMAG_DISABLE_PREVIEW_3D=1` prevents active/cached preview construction for benchmark runs. Evidence: `crates/fullmag-runner/src/native_fem.rs`, `crates/fullmag-runner/src/fem/relax/preview.rs`, `crates/fullmag-runner/src/fem/relax/snapshots.rs`, `crates/fullmag-runner/src/artifact_pipeline.rs`, `native/include/fullmag_fem.h`, and `backends/fem/src/api.cpp`.
3. Artifact writing is asynchronous, but enqueue is a bounded blocking `sync_channel` send. This is intentional back-pressure, but it means slow disk/Zarr writes can return as solver stalls. Evidence: `crates/fullmag-runner/src/artifact_pipeline.rs:1-6`, `55-60`, `81-84`, `172-215`.
4. FDM GPU heavy snapshots are well designed, but scalar reductions and adaptive decisions still synchronize the compute stream for control values. This is expected for host-driven policies, but should remain counted and bounded. Evidence: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu:721-729`, `782-790`.
5. FEM GPU direct minimizers and RK adaptive control use pinned scalar readback followed by `cudaStreamSynchronize`. This is deliberately audited, not eliminated. Evidence: `backends/fem/gpu/cuda/integrators/rk/rk_scalar_readback.cu:39-58`, `83-104`, and `backends/fem/gpu/cuda/transfer/transfer_audit.cpp:89-99`.
6. The live publisher thread removes API writes from the solver hot path. The remaining solver-thread replace/merge cost, publisher clone cost, publish lag, coalesced wake count, disconnected wake count, and approximate payload bytes are now structured diagnostics under `/v2/sessions/current/diagnostics/solver-profile`.
7. Direct-minimizer accepted steps can include many current/trial energy snapshots. Before this remediation, only the final accepted `trial_stats` was published as the step profile, while all previous trials were included in FFI `Total`, creating large `Missing` values. The profile now accumulates those snapshot timings; remaining `Missing` should be treated as preconditioner/line-search/orchestration work that still lacks a dedicated phase.
8. CPU/MFEM direct minimizers previously recomputed the accepted state at the start of the next step even though the accepted trial snapshot already contained total energy, effective field, torque, average magnetization, and demag diagnostics for the same state. The accepted snapshot is now cached as timing-free current state. A typical no-backtrack PGBB step should therefore report one Poisson solve instead of two; a one-backtrack step should report two instead of three.

The current profiler is useful for solver-step diagnosis, especially FEM demag. It is still not a complete system profiler, but artifact enqueue wait, writer lag, payload sizes, queue depth, field-copy costs, GPU scalar readbacks, native direct-minimizer subphases, and live-publish replace/merge/clone/lag costs are now visible.

## Architecture map

### Solver execution lanes

| Lane | Current performance posture | Main bottleneck class |
|---|---|---|
| FDM CPU reference | Simple, synchronous, correctness-oriented | CPU compute plus synchronous preview/observe when live output is due |
| FDM CUDA | Best async snapshot design in the stack | Scalar readbacks for reductions/adaptive policy; active preview still can block when consumed immediately |
| FEM CPU native | Rich demag timing and MFEM/hypre split | Poisson/hypre demag solve and field recomputation/snapshot work |
| FEM GPU native | Device-resident compute with audited scalar control readbacks and async-capable snapshot ABI | Demag solve/apply time; host-driven direct-minimizer decisions |

### Data/output paths

| Path | Async? | Back-pressure? | Main risk |
|---|---:|---:|---|
| Artifact scalar rows | Yes, writer thread | Yes, bounded channel | per-step `StepStats` clone/send can stall if writer falls behind |
| Artifact field snapshots | Yes, writer thread | Yes, bounded channel | snapshot construction/copy occurs before or inside writer depending backend |
| FDM CUDA native snapshots | Yes, snapshot stream + pinned buffer | Writer channel still bounded | `wait()` copies pinned payload into owned `Vec` before writing |
| FEM field snapshots | Native ABI yes for GPU-backed observables; streaming scheduled snapshots hand pending handles to writer | Writer channel bounded | in-memory fallback still materializes fields |
| Live publisher | Yes, separate thread | Coalesced wake channel | merge/clone under lock on solver thread; replace/clone/publish lag are measured in solver profile |
| Control Room preview | Native ABI yes for GPU-backed observables; active live preview and cached preview use nonblocking ready poll and handoff state | N/A | preview lag/staleness still needs clearer UI labeling |

## Detailed findings

### P0 - FEM native stats copy full fields for torque and averages - resolved

Earlier in the audit, `relax_step()` and `snapshot_step_stats()` both copied magnetization and effective field to Rust:

- `crates/fullmag-runner/src/native_fem.rs:1538-1540`
- `crates/fullmag-runner/src/native_fem.rs:1699-1701`

Those copies were then used for:

- `max_torque_residual_apm_from_field()`;
- `apply_average_m_to_step_stats()`;
- per-object scalar aggregation.

On FEM GPU this was a full device-to-host synchronization point after the native step. On FEM CPU it was a large allocation/copy outside the MFEM timer.

Current status: fixed in the runner stats paths. Native FEM stats now consume backend-published `max_torque_Apm` and `mx/my/mz`; the source contract prevents `copy_m()`, `copy_h_eff()`, `max_torque_residual_apm_from_field()`, and `apply_average_m_to_step_stats()` from returning to those stats paths.
The same contract now also blocks `set_object_average_m()` in native FEM
stats paths, so per-object average reporting cannot silently reintroduce a
full magnetization copy in `step_interruptible`, `relax_step`, or
`snapshot_step_stats`.
Exact per-object `mx/my/mz` now use the native
`fullmag_fem_backend_average_m_for_nodes_f64` ABI. Rust passes the object's
node indices derived from `mesh_parts` / `object_segments`; the native backend
synchronizes magnetization only as needed and reduces directly from
`Context::state.m_xyz`. The managed runtime bundle built on 2026-06-15 exports
the new symbol. Per-object energies are still weighted projections of the
global energy terms, not exact object-local energy reductions.

Recommendation:

- Keep a separate explicit full-field copy path only for live preview, field save, and user-requested inspection.
- Keep `field_copy_wall_time_ns` and `field_copy_bytes` visible in the solver profile for the remaining intentional field-copy paths.
- Treat exact native per-object energy reductions as future work. The current
  native hot path computes exact object-local `mx/my/mz`, while energy terms in
  `per_object_scalars` remain weighted projections.

### P0 - Native FEM `Total` under-reported real accepted-step wall time - fixed

The user's runtime sample showed large differences between `Delta wall` and `Total`, including consecutive steps:

- step 26 -> 27: `Delta wall` 7.550 s, sampled `Total` 392.5 ms, unprofiled gap about 7.16 s;
- step 27 -> 28: `Delta wall` 18.041 s, sampled `Total` 833.9 ms, unprofiled gap about 17.21 s.

Rows such as 28 -> 31 also skip unsampled steps because the UI profiler was using wall-clock sampling, but consecutive step IDs prove that sampling alone was not the whole explanation.

Root cause in the measurement path: Rust accepted the native backend's `stats.wall_time_ns` as `StepStats.wall_time_ns` without measuring the whole FFI call. Direct minimizers can execute line-search attempts, rejected trials, scalar control decisions, or other native work that is not fully represented in the native phase sum. The runner now measures `fullmag_fem_backend_step()` and `fullmag_fem_backend_relax_step()` end to end and uses `max(stats.wall_time_ns, ffi_wall_time_ns)`.

Remaining interpretation:

- `Total` now covers at least the real Rust-to-native step call wall time;
- `Missing`/`Unattributed` inside a row now highlights native work not split into exchange/demag/RHS/etc.;
- `Delta wall` remains sample-to-sample real time;
- `Gap = max(0, Delta wall - Total)` highlights time between sampled rows that is not covered by the sampled accepted step. With wall-clock sampling, it may include unsampled steps; with consecutive step rows, it indicates true idle/orchestration/backend work outside the reported accepted step.

### P0 - FEM live payload preparation is partially async-capable

FEM live loop still prepares some heavy payloads in the solver loop:

- live magnetization payloads use `FemLiveMagnetizationHandoff`: they start `backend.begin_field_snapshot("m", ...)`, poll `fullmag_fem_field_snapshot_ready`, and publish only completed payloads instead of blocking the solver loop;
- active preview in LLG and direct minimizer loops uses `FemLivePreviewHandoff`: it starts `backend.begin_live_preview_snapshot()`, polls `fullmag_fem_preview_snapshot_ready`, publishes completed snapshots, and can reuse the last completed preview for the same request instead of blocking on `wait()`;
- cached-preview warming uses `FemCachedPreviewHandoff`: it starts preview snapshots, polls readiness, and only publishes completed cached fields instead of synchronously waiting in the solver loop;
- scheduled relaxation field snapshots use `backend.begin_field_snapshot(quantity)?.into_vector_field()?` instead of direct `copy_m()` / `copy_h_*()` dispatch;
- live magnetization payloads and final magnetization output also use field snapshot handles instead of direct `backend.copy_m(...)`;
- streaming scheduled field snapshots enqueue pending native snapshot handles to the artifact writer rather than waiting/writing on the solver finalization path;

`copy_live_preview_field()` dispatches to full observable copy functions. Torque preview no longer calls two Rust-side full-field copies; it now requests the native torque observable:

- `crates/fullmag-runner/src/native_fem.rs:1841-1877`;
- `copy_torque()` requests `FULLMAG_FEM_OBSERVABLE_TORQUE` at `native_fem.rs`;
- `context_copy_field_f64(..., FULLMAG_FEM_OBSERVABLE_TORQUE, ...)` computes torque in native `state_io.cpp`.

Current status:

- Native GPU-backed FEM snapshot payload preparation now uses CUDA-style async staging modeled after FDM CUDA: device staging, pinned host buffers, and a dedicated snapshot stream.
- Active live preview no longer consumes preview snapshots synchronously after `begin_live_preview_snapshot()`. It polls readiness and keeps pending/last-good state across solver steps. Cached preview uses the same readiness polling pattern for non-active quantities. Live magnetization payloads also poll field-snapshot readiness and skip publishing a fresh payload until the native snapshot is ready. `FULLMAG_DISABLE_PREVIEW_3D=1` withholds display-selection callbacks from the runner and disables initial 3D snapshots, so preview-off benchmark runs do not build active/cached preview payloads. Streaming scheduled field snapshots are writer-owned.

Recommendation:

- Add an explicit preview lag/revision marker so the UI can distinguish last-good active preview from a freshly completed preview.
- Keep scheduled FEM field snapshot waiting/writing in the artifact writer path for streaming runs; preserve in-memory fallback for non-streaming tests and callers.
- For GPU torque preview, implement a future device-side/downsampled torque snapshot so the GPU path does not need synchronous source-field readback before returning the torque payload.
- Make `field_every_n` an explicit runtime tuning knob in UI and CLI; current defaults are FEM=10, FDM=50 unless preview is disabled.

### P0 - FEM demag solve is the dominant compute kernel and needs solver-policy visibility

The user's profiler sample showed total step time almost equal to demag time. Code confirms the native demag path measures:

- RHS assembly;
- hypre solve;
- recovery;
- energy;
- setup/apply reuse state.

Evidence:

- `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp:65-76` assembles RHS and times it;
- `demag_poisson_solve.cpp:165-176` times hypre solve;
- `demag_poisson_solve.cpp:182-221` times recover/energy and accumulates phase timings;
- `backends/fem/cpu/mfem/interactions/demag_poisson_telemetry.cpp` publishes the phase fields into `fullmag_fem_step_stats`;
- `crates/fullmag-runner/src/solver_profile.rs:195-225` exposes demag subphases to the profile model.

Current status:

- Solver iteration count, final residual, setup reuse, apply time, and resolved solver/preconditioner policy are now visible in the profiler/UI diagnostics.
- Managed benchmark gates can fail on excessive demag apply time, iteration count, and missing multi-step setup reuse without needing an accepted baseline CSV.
- The setup-reuse gate is now a general multi-step demag benchmark contract, not only a fixed-mesh readiness check.

Important runtime-scaling constraint: the current non-periodic Hypre wrapper constructs `HypreParMatrix`, `HypreParVector`, and Krylov solvers with `fullmag_serial_comm()`, which returns `MPI_COMM_SELF`. The row partition is `{0, glob_size}`. That is correct for the current in-process managed runtime, but it means the Poisson system is not distributed across MPI ranks. Full CPU utilization for large airbox solves requires either a tuned shared-memory Hypre/OpenMP path or a separate distributed mesh/matrix ownership project; it will not appear just because OpenMPI libraries are bundled.

### P0 - Direct-minimizer line-search snapshot costs were hidden in `Missing` - fixed in profiler

Latest evidence from the live footer showed rows such as:

- step 19: `Total=15.70 s`, `Demag=1.09 s`, `Setup=reused`, `Missing=13.51 s`;
- step 18: `Total=19.71 s`, `Demag=1.26 s`, `Setup=reused`, `Missing=17.18 s`;
- step 15: `Total=27.30 s`, `Demag=1.07 s`, `Setup=reused`, `Missing=25.16 s`.

A later live footer sample after preconditioner instrumentation showed `Missing=0 ns`, `Setup=reused`, `Relax prec.` around 6-7 ms, `Demag` around 3-8 s, and `Native` as the dominant 17-197 s cost. That proves the active issue is no longer demag setup, artifact enqueue, exchange+mass operator assembly, or profiler accounting. The bottleneck is native direct-minimizer driver work outside demag/preconditioner phases.

That ruled out repeated demag solver setup as the primary cause for this run. Code inspection showed the direct-minimizer algorithms compute `current_stats`, then one or more `trial_stats` inside Armijo line search, but `finish_accepted_relaxation_step()` previously published only the final accepted `trial_stats`. The runner-level FFI `Total` included the whole native call, so all discarded trial snapshots appeared as unattributed `Missing`.

Current status: profile attribution fixed. `projected_gradient_bb`, `nonlinear_cg`, and `tangent_plane_implicit` now accumulate current-state and trial snapshot timings into the accepted step. After rebuild, `Demag` should represent the sum of demag work across the current state and all accepted/rejected trials in that step.

The direct-minimizer exchange+mass preconditioner path is also now a dedicated phase. It is measured in `exchange_mass_preconditioned_gradient()`, carried through `fullmag_fem_step_stats`/`StepStats`, published as solver-profile phase `relax_preconditioner`, printed in compact engine logs, and shown in the footer as `Relax prec.`.

The assembled `mass + weight * exchange` operator is now cached in `FemRelaxationRuntimeState` and destroyed during MFEM context teardown. Reuse is deliberately exact-keyed: same mass matrix pointer, exchange matrix pointer, matrix dimensions, and effective clamped `weight`. Solver-profile samples carry cache hit/miss counters, and compact logs print `relax_prec_cache=hits/misses`.

Updated interpretation after adding the `Native` phase:

- if `Relax prec.` is large and cache misses are high, the immediate optimization target is step-size/weight policy or broader cache keying;
- if `Relax prec.` is large and cache hits are high, the immediate optimization target is the scalar linear solve/preconditioner policy;
- if `Native` is large while `Relax prec.` and `Demag` are small, inspect the `copy/upload/ret/grad/metric/ls/upd` breakdown. A large `upload` in builds before this fix meant hidden effective-field refresh through the public upload path; in current builds it should be only trial-state validation/copy;
- if `Missing` remains large after `Native` appears, the remaining unattributed time is outside both Rust-measured FFI overhead and structured runner phases;
- if `Demag` grows and `Missing` shrinks, the previous missing time was hidden line-search trial demag work.

Next optimization candidate:

- The direct-minimizer exchange+mass preconditioner still solves three scalar systems per call. Its Hypre variant constructs `HypreParMatrix`, `HypreBoomerAMG`/preconditioner, and `HyprePCG` inside `solve_scalar_hypre_system()`. Exact operator caching removes repeated assembly for identical weights, but not solve cost or Hypre preconditioner setup. A broader optimization needs an explicit policy for fixed/reused preconditioner weight, or a dedicated cached Hypre operator/preconditioner/solver object keyed by the effective weight. This is analogous to mumax caching a geometry-dependent demag kernel, but in FEM the cache key is the assembled operator/preconditioner, not an FFT kernel.

### P1 - Artifact pipeline is correct but still can back-pressure the solver

Artifact pipeline design is intentionally bounded:

- module contract says it moves field snapshots off the hot path and uses bounded back-pressure rather than unbounded RAM: `artifact_pipeline.rs:1-6`;
- default capacity is 4: `artifact_pipeline.rs:27`;
- writer thread is `fullmag-artifact-writer`: `artifact_pipeline.rs:81-84`;
- enqueue uses blocking `SyncSender::send`: `artifact_pipeline.rs:55-60`;
- scalar rows clone `StepStats` before enqueue: `artifact_pipeline.rs:172-175`;
- native CUDA snapshots require streaming pipeline: `artifact_pipeline.rs:200-215`;
- writer writes CSV/Zarr on the writer thread: `artifact_pipeline.rs:410-518`.

This is the right failure mode for correctness, but it can still block the solver when disk I/O falls behind. Enqueue delay and live writer-thread progress are now visible in solver-profile samples and Control Room footer diagnostics.

Recommendation:

- Keep monitoring `artifact_enqueue_block_wall_time_ns`.
- Keep tracking current and max queue occupancy.
- Keep tracking writer cycle time per job kind.
- For interactive runs, consider lossy/coalesced scalar rows for live-only telemetry while keeping artifact persistence lossless.
- Keep bounded back-pressure for scientific artifact saves; do not switch to unbounded queues.

### P1 - Live publisher is async but not fully invisible to the solver - instrumented

The publisher has good structure:

- separate publisher thread: `live_workspace.rs:535-561`;
- wake channel is `sync_channel(1)`;
- `try_send()` coalesces wakeups: `live_workspace.rs:577-582`;
- scalar telemetry is gated by `LIVE_SCALAR_TELEMETRY_INTERVAL`: `live_workspace.rs:497-520`;
- publish loop enforces min interval and logs cycles above 100 ms: `live_workspace.rs:1042-1079`.

Remaining cost:

- `replace()` filters and merges payloads under locks on the solver-side caller path: `live_workspace.rs:585-594`;
- publisher clones the pending payload before sync: `live_workspace.rs:1065`;
- these costs are now structured diagnostics, but the costs still exist when payloads are large.

Recommendation:

- Use the new live publisher diagnostics to set a real payload budget and decide whether FEM preview/magnetization payloads need an async snapshot path or smaller default cadence.
- Consider moving heavy preview payload ownership to immutable shared buffers so pending-payload merge does not clone large vectors.
- Keep publish thread separate; do not push API writes back into solver code.

### P1 - FDM CUDA snapshot design is strong; scalar decisions still synchronize

FDM CUDA native snapshot API explicitly schedules:

- device-to-device staging on compute/default stream;
- device-to-host transfer into pinned memory on a dedicated snapshot stream.

Evidence: `native/include/fullmag_fdm.h:588-625`.

Runner wraps this with `begin_field_snapshot()` and `begin_live_preview_snapshot()`:

- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs:1305-1360`.

The `wait()` path copies pinned data into an owned `Vec` before writer output:

- `native.rs:1656-1723`.

Scalar reductions still synchronize:

- max scalar readback: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu:721-729`;
- adaptive policy readback: `reductions_fp64.cu:782-790`.

Recommendation:

- Keep async snapshot API as the model for FEM GPU.
- Add scalar readback counts/bytes to regular FDM GPU step stats.
- Batch scalar decisions where possible, but keep host-driven adaptive decisions explicit and measured.

### P1 - FEM CUDA control scalar readbacks are audited but still host-driven

FEM CUDA scalar readback uses pinned host staging, `cudaMemcpyAsync`, then `cudaStreamSynchronize`:

- `backends/fem/gpu/cuda/integrators/rk/rk_scalar_readback.cu:39-58`;
- `rk_scalar_readback.cu:83-104`.

Transfer audit counts control scalar reads separately:

- `backends/fem/gpu/cuda/transfer/transfer_audit.cpp:89-99`.

Direct minimizers use this for Armijo/BB/NCG decisions, and tests intentionally assert that these host-driven control syncs are visible.

Recommendation:

- Treat these as acceptable transitional syncs, not hidden bugs.
- Add a target design: device-side line-search policy or batched candidate evaluation to reduce per-backtrack host sync.
- Keep the audit split between control-scalar readbacks and illegal full-field hot-loop readbacks.

### P2 - FDM CPU reference live path is synchronous by design

The FDM CPU reference loop measures only `step_reference_fdm_problem()` as step wall time:

- `crates/fullmag-runner/src/fdm/cpu/reference.rs:970-1004`.

After that, live preview can synchronously:

- build direct preview;
- compute observables;
- flatten magnetization;
- call live `on_step`.

Evidence: `fdm/cpu/reference.rs:1024-1111`.

This is acceptable for the reference lane, but it must not be used as a production interactive performance baseline without accounting for post-step live payload cost.

Recommendation:

- Add preview/live payload time fields to FDM CPU `StepStats`, matching FEM's `preview_wall_time_ns`, `cached_preview_wall_time_ns`, and `orchestration_wall_time_ns`.
- Use FDM CUDA or production FDM for performance claims.

### P2 - Final FEM snapshots still build full field values before artifact finish - instrumented

Final FEM artifact creation copies full fields before enqueue:

- `crates/fullmag-runner/src/fem/relax/finalize.rs:96-104`;
- final magnetization copy at `finalize.rs:107`.

This is outside the hot per-step path in normal relaxation, but it can make completion appear to hang after the last solver step.

Current status: instrumented. Finalization wall time and full-field copy bytes now attach to the final sampled step as the `finalization` solver-profile phase and the Control Room `Finalization` column. A value of `0 ns` during an active run means the stage has not reached end-of-stage finalization yet.

Remaining recommendation:

- Prefer native async snapshots for FEM GPU final field outputs once available.

## Current profiler coverage

The solver profile now includes:

- total step time;
- RHS total;
- exchange;
- demag total;
- local terms;
- snapshot;
- preview;
- cached preview;
- orchestration;
- unattributed time;
- demag subphases;
- field-copy bytes and wall time;
- artifact enqueue wait, writer job time, writer split times, and queue depth;
- GPU scalar readback bytes/sync counts;
- native direct-minimizer residual and subphases: state copy, state upload, retraction, gradient, metric, line search, and update;
- finalization phase timing and final full-field copy bytes for end-of-stage outputs;
- live publisher replace/merge/clone/publish lag, coalesced wake count, disconnected wake count, and approximate payload bytes.

Evidence: `crates/fullmag-runner/src/solver_profile.rs:127-225`.

Still missing:

- full demag linear-solver performance parity. Native GPU-backed FEM payload preparation now stages asynchronously, active live preview uses last-good readiness polling, cached preview uses readiness polling, live magnetization payloads use field-snapshot readiness polling, streaming scheduled field snapshots use artifact-writer handoff, and preview-off benchmark mode prevents preview construction. The remaining runtime bottleneck in current samples is Hypre demag apply time, not preview payload construction.

## Recommended implementation plan

### Phase 1 - Measurement closure

1. Add structured counters:
   - `field_copy_bytes`
   - `field_copy_wall_time_ns`
   - `artifact_enqueue_block_wall_time_ns`
   - `artifact_writer_job_wall_time_ns`
   - `artifact_queue_depth_max`
   - `live_payload_merge_wall_time_ns` -> implemented as `live_publisher.last_merge_wall_time_ns` / `total_merge_wall_time_ns`
   - `live_publish_lag_ms` -> implemented as `live_publisher.last_publish_lag_wall_time_ns`
   - `live_payload_estimated_bytes` -> implemented as `live_publisher.last_payload_estimated_bytes` / `max_payload_estimated_bytes`
2. `field_copy_*`, `artifact_enqueue_*`, `artifact_writer_*`, queue depth, GPU sync counters, native FFI overhead, and live publisher diagnostics are now in `/v2/sessions/current/diagnostics/solver-profile`.
3. Control Room footer now shows live publisher queue/back-pressure summary beside solver threading.
4. Add a "preview disabled" benchmark mode and show it in profiler output when active. Implemented through `FULLMAG_DISABLE_PREVIEW_3D=1`: runner-side preview construction is gated, the solver-profile payload carries `preview_3d_disabled`, OpenAPI/generator output exposes it to Control Room, and the footer profiler labels benchmark samples when the flag is active.

### Phase 2 - Remove avoidable FEM full-field stats copies

1. Compute `max_torque_Apm` in native FEM backend without copying full `m` and `H_eff` to Rust.
2. Compute global `mx/my/mz` and per-object averages in native backend reductions. Global `mx/my/mz` now come from native stats; exact object-local `mx/my/mz` use `fullmag_fem_backend_average_m_for_nodes_f64`; source contracts prevent Rust full-field copies from returning for scalar stats.
3. Keep full field copies only for explicit visualization, artifact save, or user inspection.
4. Add tests asserting `snapshot_step_stats()` does not perform full observable field readback on GPU when only scalar stats are requested.

### Phase 3 - FEM async preview/snapshot parity with FDM CUDA

1. Add native FEM GPU `begin_preview_snapshot` and `begin_field_snapshot` APIs with true asynchronous staging. Implemented for GPU-backed observables.
2. Use pinned host buffers and a dedicated snapshot stream. Implemented in the native ABI.
3. Resolve field snapshots in artifact writer and preview snapshots through last-good preview handoff. Streaming scheduled field snapshots, live magnetization handoff, active live preview handoff, and cached-preview handoff are implemented.
4. Publish last-good preview if a fresh preview is still pending. Implemented for active live preview requests with the same request configuration.
5. Add preview-off benchmark gating. Implemented through `FULLMAG_DISABLE_PREVIEW_3D=1`: no initial 3D snapshot, no active display-selection callback, and no active/cached preview builder calls in runner live paths.
6. Add back-pressure policy: bounded queue, visible lag, no unbounded RAM.

### Phase 4 - Demag solver optimization

1. Audit hypre setup reuse across fixed mesh/material runs.
2. Surface iteration counts and setup reuse in UI. The footer profiler now shows setup reuse, demag solve count, Poisson iteration count, final residual, and solver apply time; per-object/detail views still need this context.
3. Add CPU baseline cases in `docs/performance/fem_cpu_baselines.md`. Managed-runtime benchmark wiring is documented; accepted-baseline mechanics now pass with a persistent generated-domain-mesh cache, but accepted machine-specific baseline publication policy is still open.
4. Run parameter sweeps for hypre solver/preconditioner/tolerance settings. The production/demag-performance recipes already sweep solver/preconditioner settings and emit best-policy summaries; the demag-performance recipe accepts `FULLMAG_BENCH_DEMAG_RTOLS` for relative-tolerance sweeps and `FULLMAG_BENCH_DEMAG_AMG_*` lists for BoomerAMG profile sweeps, including optional strength-threshold and max-level overrides. Coarse, medium, and repo-fine managed reuse-domain-mesh sweeps now pass with stable mesh signatures and durable `best_demag_policy` artifacts. Repeat the same sweep on the user's current large live model before changing the global default demag policy.
5. Add regression thresholds for demag solve time, iteration count, and setup reuse. Implemented for iteration count, absolute solver-apply budget, multi-step setup-reuse proof, and accepted-baseline CSV comparison. The gate now supports persistent generated-domain-mesh cache directories so baseline/current rows can share `solver_mesh_signature`; the remaining task is selecting a controlled-machine baseline file to archive or commit.

### Phase 5 - Host-driven GPU control policy reduction

1. Batch scalar readbacks where multiple decisions need adjacent scalars.
2. Evaluate device-side Armijo/line-search control for PG-BB/NCG.
3. Keep transfer audit as the guardrail: control scalar sync is allowed and counted; full hot-loop field sync remains a violation.

## Verification plan

Use managed/container-backed recipes for native FEM proof:

1. `just ensure-managed-fem-runtime`
2. `just verify-fem-relaxation-runtime`
3. `just fem-managed-headless <representative script>`
4. `just fem-gpu-headless <representative script>` when GPU lane is touched

Benchmark matrix:

| Case | Goal |
|---|---|
| FEM CPU, preview off | pure native solver/demag baseline |
| FEM CPU, preview on, field_every_n=10 | current interactive default |
| FEM CPU, save m every step | artifact back-pressure stress |
| FEM GPU, RK adaptive | scalar readback/control-sync profile |
| FEM GPU, PG-BB/NCG | Armijo/line-search readback profile |
| FDM CUDA, preview on/off | async snapshot effectiveness |
| FDM CPU reference | correctness lane, not production perf target |

Acceptance criteria:

- reported step total plus structured queue/payload phases accounts for wall-clock step cadence within 5-10%;
- no unbounded memory growth under save-every-step stress;
- preview disabled mode removes preview/cached-preview work from solver cadence;
- FEM GPU stats-only polling does not copy full fields;
- artifact writer lag is visible before it becomes a user-facing freeze.

## Bottom line

The solver stack is not missing async infrastructure globally. The missing pieces are narrower and more important:

- FEM stats should stop copying full fields for scalar diagnostics;
- FEM native preview/snapshot ABI now uses the same async/pinned-buffer model as FDM CUDA for GPU-backed observables, streaming field snapshots use writer handoff, active live preview uses readiness/last-good handoff, cached preview uses readiness polling, live magnetization payloads use field-snapshot readiness handoff, and preview-off benchmark mode gates active/cached preview construction;
- artifact and live queues need structured lag/back-pressure diagnostics;
- demag solver subphase visibility should now drive the next optimization pass: current samples show `demag_solver_apply`, not hidden orchestration, dominates accepted-step wall time.

Fixing those items should make the profiler reflect the real wall-clock behavior the user sees: solver compute, payload preparation, host-device synchronization, artifact back-pressure, and live-publish delay as separate, attributable costs.
