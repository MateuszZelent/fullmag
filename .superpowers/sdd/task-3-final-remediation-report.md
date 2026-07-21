# Task 3 final remediation report

Date: 2026-07-21

## Outcome

Task 3 is implemented and verified for its stated mesh-generation ownership contract. A FEM mesh stage now creates one `StageFemMeshAsset`, computes its generation identity once, and propagates that precomputed identity through runner dispatch, native/reference relaxation, eigen and frequency-response progress, hysteresis settle/retry paths, interactive execution, CLI initialization, replay, snapshots, and final callbacks. Remeshing creates a new asset and therefore a new identity; repeated publication of one stage asset does not rehash its topology.

The source contract is fail-closed over the exact `.fem_mesh` access inventory and rejects callback/loop hashing, duplicate hash functions, and FEM-shaped updates with a missing generation.

## Focused verification

- `python3 scripts/verify_fem_mesh_hot_loop_source_contract.py --self-test` — PASS, including callback-hash, loop-hash, duplicate-hash, and missing-generation mutation fixtures.
- `python3 scripts/verify_fem_mesh_hot_loop_source_contract.py` — PASS; exact inventory: 191 `.fem_mesh` accesses.
- `cargo check -p fullmag-runner --lib` — PASS.
- `cargo check -p fullmag-cli` — PASS.
- `CARGO_TARGET_DIR=/tmp/task3-final-target cargo test -p fullmag-runner --lib fem_mesh -- --nocapture --test-threads=1` — PASS, 8/8. This includes `stage_fem_mesh_asset_survives_initialization_and_stage_zero_without_rehash` and the payload/remesh fingerprint counters.
- `CARGO_TARGET_DIR=/tmp/task3-final-target cargo test -p fullmag-api session::tests::runtime_frame_accepts_stage_mesh_once_and_preserves_it_across_steps --no-default-features -- --exact --nocapture` — PASS, 1/1.
- `CARGO_TARGET_DIR=/tmp/task3-final-target cargo test -p fullmag-cli -- --test-threads=1` — PASS, 217/217.
- `git diff --check` — PASS.

## Managed native verification

- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-source-contract` — PASS; semantic mesh gate plus all three native source contracts.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime` — PASS; rebuilt the managed bundle from the remediated source and completed the CPU/GPU runtime matrix.

## Performance gate and controlled A/B

Two standalone `verify-fem-gpu-performance-regression` attempts were noisy. The first reported GPU p95 5749.48 ms versus accepted 5225.245 ms (+10.03%). The second reported CPU p95 12007 ms (+8.22%) and GPU p95 6144.69 ms (+17.60%). Both attempts still passed all ten rows, CPU/GPU consistency, strict GPU residency, convergence, and stable-mesh checks; only the 5% end-to-end timing threshold failed.

A controlled back-to-back A/B then ran in one managed GPU container with the same fixture, arguments, warmup, five CPU repetitions, five GPU repetitions, and strict gates. It used the actual immutable executable `.fullmag/runtimes/fem-gpu-variants/pre-remediation-sm52-65e02cbed5dc/bin/fullmag-fem-gpu-bin` (SHA-256 `540d7e6bf7e798862753852141b0971585421e6e871f8ab75a8226fb3875f8b7`) and the actual current executable `.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin` (SHA-256 `2527dd1fc1dd2c3f47f4809025e35ad8a5fce65775b114a5635117f000ed3e48`). Results:

| Runtime | CPU p95 | GPU p50 | GPU p95 | GPU vs accepted |
|---|---:|---:|---:|---:|
| Immutable pre-remediation | 10734.417 ms | 5284.757 ms | 5497.646 ms | +5.21% |
| Current remediated | 10765.527 ms | 5163.333 ms | 5284.215 ms | +1.13% |

The current runtime was 3.88% faster than the immutable runtime by GPU p95 and was inside the accepted 5% threshold. Both A/B sides passed 10/10 rows, consistency, convergence, strict residency, and stable-mesh checks. The earlier standalone failures are therefore environment/timing variance, not a Task 3 regression. Raw artifacts are retained at:

- `.fullmag/reports/task3_ab_immutable.csv`
- `.fullmag/reports/task3_ab_immutable_summary.json`
- `.fullmag/reports/task3_ab_current.csv`
- `.fullmag/reports/task3_ab_current_summary.json`

NVIDIA telemetry around the A/B showed the expected transition from idle (`P8`, 210 MHz graphics, 405 MHz memory, 42 C) to active/post-run state (`P2`, 2760 MHz graphics, 11251 MHz memory, 52 C), without evidence of thermal or power-limit throttling in the post-run diagnostic.

## Full runner suite and inherited failures

The serial full runner suite completed with 596/598 passing. The two failures were:

- `fdm::cpu::reference::tests::direct_minimizer_completion_reports_energy_convergence`: observed `None`, expected `Some(Energy)`.
- `hysteresis::tests::zero_field_relaxed_writes_preparation_settle_trace_without_reindexing_points`: observed `non_converged`, expected `converged`.

Both exact tests were rerun in a detached worktree at the Task 3 base `d40ea448` with a separate `/tmp/task3-base-target`; both failed identically there. They are pre-existing baseline failures and are outside this mesh-identity remediation. No Task 3-focused test failed.

## Scope

No native FEM `Context` or solver-state ownership was changed. The remediation is confined to Rust runner/CLI mesh identity ownership, publication paths, tests, and the semantic source gate. The pre-existing `.superpowers/sdd/progress.md` modification was not touched or staged.
