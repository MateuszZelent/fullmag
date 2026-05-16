# Native FEM CPU Lazy Initial Snapshot

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related notes:
  - `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`
  - `docs/physics/0819-native-fem-cpu-demag-hypre-solve-telemetry.md`
- Related report:
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`

## 1. Problem statement

The native FEM time-domain runner currently calls `snapshot_step_stats()` before
entering the stepping loop. For a headless production run this computes the full
effective field at `t = 0`, including Poisson demag, even though the first
reported step is produced by the time integrator itself.

That initial snapshot is useful for live UI updates and direct minimization, but
it is avoidable overhead for non-live LLG time integration.

## 2. Physical model

No physics changes. The LLG update, effective-field terms, demag Poisson solve,
energy formulas, and stop criteria remain unchanged.

The optimization only changes when runtime telemetry is sampled. The first
accepted time step still computes its own `H_eff`, torque, energies, and demag
state through the native backend.

## 3. Runtime rule

The native FEM runner must take an initial full snapshot only when it is
semantically required:

- live execution needs an initial step-0 payload,
- direct minimization needs initial energy and `H_eff` for the tangent
  gradient.

For headless time-domain stepping without direct minimization, the runner may
defer full stats until the first accepted step. Final provenance must still be
filled from the final `StepStats`.

## 4. API, IR, and planner impact

- Python API: no change.
- `ProblemIR`: no change.
- Planner: no change.
- Runtime artifacts: final metadata remains sourced from final `StepStats`.
- Benchmark CSV: no schema change; the hidden pre-step demag solve should no
  longer be paid by CPU benchmark runs.

## 5. Validation strategy

1. Unit-test the runner decision so headless time-domain does not require an
   initial snapshot, while live and direct-minimization paths still do.
2. Run native FEM runner tests that cover demag profiling/provenance.
3. Rebuild the managed FEM runtime bundle.
4. Run unsandboxed profiled CPU `exchange_demag` smoke and confirm the first
   `demag call` appears after `native-fem LLG loop`, not during backend
   creation.
5. Run CPU benchmark CSV smoke and confirm the first timed step exposes Hypre
   setup/apply/reuse telemetry.

## 6. Completeness checklist

- [x] Runtime decision helper added and tested.
- [x] Headless time-domain path defers initial snapshot.
- [x] Live/direct-minimization paths still keep initial snapshot.
- [x] Native backend creation can skip eager initial effective-field refresh.
- [x] Unit tests pass.
- [x] Managed FEM runtime bundle rebuilt.
- [x] Unsandboxed CPU demag smoke passes.

## 7. Validation evidence

- `cargo test -p fullmag-fem-sys plan_desc_has_consistent_mass_field -- --nocapture`: passed.
- `cargo test -p fullmag-runner native_fem_initial_snapshot_is_lazy_for_headless_time_domain --features fem-gpu -- --nocapture`: passed.
- `cargo check -p fullmag-cli --features "cuda fem-gpu"`: passed.
- `just rebuild-fem-runtime`: rebuilt the managed FEM runtime bundle.
- Profiled headless smoke with `FULLMAG_FEM_STEP_PROFILE=1` and `FULLMAG_FEM_EXECUTION=cpu` completed; `native-fem LLG loop` was logged before the first `demag call`.
- `python3 scripts/analysis/fem_gpu_benchmark.py --backends cpu --meshes coarse --scenarios exchange_demag --integrators heun --steps 1 --output /tmp/fullmag_fem_cpu_lazy_initial_snapshot_smoke.csv --require-mfem-stack`: passed with `status=ok`, `demag_solver_setup_wall_time_ms=22.557245`, `demag_solver_apply_wall_time_ms=677.430777`, and `demag_solver_setup_reused=True`.
