# Task 7 report — canonical FEM GPU NCG three-sync accounting

Date: 2026-07-23

Status: implementation complete. The canonical NCG sync budget, energy/trajectory consistency, managed source contract, and managed runtime contract pass. The exact performance recipe remains red only because its pre-existing accepted fixture/baseline mesh signature does not match the currently realized solver mesh; the NCG sync gate itself passes all five GPU rows.

## Delivered contract

- GPU NCG trial preparation now computes fresh-demag effective field and final energy-term slots entirely on device through `gpu_relax_compute_effective_field_and_energy_terms`.
- Normal and forced-restart recovery trials reuse `GpuDirectArmijoResult::trial_snapshot.total_energy_j`; the redundant standalone total-energy reduction/readback is gone.
- Non-finite trial-energy diagnostics, rollback, direct-energy refinement, fresh-zero demag, PR+ direction update, profiler behavior, and public FEM ABI remain unchanged.
- The benchmark applies the exact cumulative NCG limit:

  `initial_syncs + 3 * executed_steps + max(0, total_rhs_evals - 2 * executed_steps)`.

- `run-json` now publishes the same last-step and cumulative RHS telemetry already present in script-mode summaries, and the benchmark recognizes the `output_dir`-identified `run-json` payload.
- The managed performance recipe honors `FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP` and `FULLMAG_BENCH_REPEAT`, and enables the control-readback budget gate.

## TDD chronology

1. Managed source-contract RED failed with:
   `native FEM GPU direct minimizers must expose a fresh-demag effective-field/energy-term compute helper without a host scalar readback`.
2. Focused Python RED rejected the old NCG default/budget structure; 32 accepted steps with 64 RHS evaluations now allow 99 synchronizations and reject 100, while 66 RHS evaluations allow 101 and reject 102.
3. Recipe-source RED showed that the performance recipe ignored both requested environment overrides and did not enable the sync gate.
4. The first measured rerun failed closed on missing `total_rhs_evals`. Investigation showed that direct minimizers have no timestep policy and therefore intentionally do not write `solver_steps.csv`; the canonical `run-json` summary also omitted RHS counters.
5. A source RED required `run_json_summary` to publish last-step and cumulative RHS telemetry. The Rust summary and its unit assertion now publish `rhs_evals` and the exact sum of all `StepStats::rhs_evals`.
6. The next measured rerun still failed closed because the parser rejected JSON summaries identified by `output_dir`. A focused RED reproduced `payload is None`; recognizing the existing `run-json` discriminator made the focused parser test green.

## Fresh verification

- `COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml just verify-fem-relaxation-source-contract`: passed. The managed CUDA build completed the relaxation, stage-completion, and explicit-RK contracts; semantic mesh ownership reported 191 classified accesses and 64 producers.
- `COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml just verify-fem-relaxation-runtime`: passed after a managed runtime rebuild. The bundle validated as `candidate-sm89` on the RTX 4080 SUPER with 1536 HYPRE bindings, and all GPU/CPU relaxation lanes completed, including GPU NCG.
- Focused Task 7 Python contracts for run-json telemetry publication/parsing, exact NCG budget, and recipe wiring: passed.
- Exact requested command:

  `COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP=3 FULLMAG_BENCH_RELAX_ALGORITHMS=nonlinear_cg FULLMAG_BENCH_REPEAT=5 just verify-fem-gpu-performance-regression`

  executed five CPU and five GPU rows. All 10 rows were `ok`; CPU/GPU energy and trajectory consistency passed with no failures; strict GPU residency passed. Every GPU row reported:

  - `executed_steps = 64`
  - `total_rhs_evals = 65`
  - `hot_loop_control_scalar_host_sync_count = 193`

  The canonical maximum is `3 + 3 * 64 + max(0, 65 - 128) = 195`, so all five measured rows pass the exact Task 7 sync contract. GPU wall-time p50 was 5292.427 ms versus CPU 10572.091 ms, about 2.0x CPU/GPU speedup for this run.

## Independent pre-existing performance-gate blocker

The exact performance command exits 18 only on fixture/baseline identity. The current solver produces signature `20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431` with 1200 nodes and 5138 elements, while both the named fixture and accepted baseline require `83dc036495e6f5c13d101dd94c010ee1af9b6ac560892d66411a4140172a2f41` for the same counts. Consequently all 10 rows report `solver_mesh_signature differs from fixture`, and the accepted baseline has no comparable signature.

No fixture or accepted baseline was rewritten in Task 7: doing so would convert a fail-closed scientific identity gate into an unreviewed acceptance update. The generated report remains at `.fullmag/reports/fem_gpu_performance_regression.csv`; it is runtime evidence and is not staged.

The standalone no-argument `scripts/test_validate_fem_relaxation_runtime_log.py` test-list runner also has a pre-existing stale reference to `test_fem_pgbb_demag_is_excluded_from_production_manifest` while the defined function is named `test_fem_pgbb_demag_is_included_in_current_production_manifest`. Task 7 focused tests were invoked directly and pass; this unrelated stale runner entry was preserved.

## Scope and repository hygiene

- The additional `crates/fullmag-cli/src/main.rs` change is required runtime telemetry plumbing discovered by the fail-closed measured gate; without it, `run-json` cannot supply the cumulative RHS value mandated by the Task 7 formula.
- `.superpowers/sdd/progress.md` was pre-existing and unrelated; it was neither edited nor staged by Task 7.
- Generated runtime bundles and benchmark reports remain untracked/ignored operational artifacts and are not part of the commit.
