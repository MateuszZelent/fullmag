# Native FEM CPU Demag Hypre Solve Telemetry

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related notes:
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`
  - `docs/physics/0818-native-fem-cpu-benchmark-matrix.md`
- Related report:
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`

## 1. Problem statement

The first real native FEM CPU `exchange_demag` benchmark row shows that the
Poisson demag solve phase dominates the step. The current
`demag_solve_wall_time_ns` field measures the whole solve phase, including the
first-call Hypre/AMG setup when it happens. That is not enough to distinguish:

- one-time `HypreParMatrix`, preconditioner, and Krylov solver setup,
- subsequent cached solver application,
- accidental loss of reuse.

The next CPU optimization step needs this distinction before changing solver
policy.

## 2. Physical model

No physics changes. The demagnetizing field remains:

```text
H_demag = -grad(u)
```

where `u` is solved by the existing FEM Poisson demag realization on the
shared-domain mesh. The demag energy remains the existing volume contribution
plus the existing Robin boundary contribution when Robin demag is selected.

## 3. Runtime interpretation

The native CPU backend must continue to report:

- `demag_solve_wall_time_ns`: full Poisson solve phase wall time.

It must additionally report sub-timings:

- `demag_solver_setup_wall_time_ns`: time spent creating the Hypre matrix,
  preconditioner, and Krylov solver for this step.
- `demag_solver_apply_wall_time_ns`: time spent in the actual linear solver
  application for this step.
- `demag_solver_setup_reused`: true when the step observed cached Hypre setup
  reuse.

For the first non-periodic demag solve on a context, setup time is expected to
be non-zero and reuse is expected to be false for that solve. For subsequent
solves on the same context, setup time should be zero and reuse should be true.
Step-level timings aggregate all demag solves in that step. A non-zero setup
time therefore means setup happened during the step; the reuse flag means at
least one solve in the step reused cached setup. Headless runs may also compute
an initial snapshot before the first reported time step, so a benchmark row can
show `setup=0` and `reused=true` when the timed step is already warm.

These fields are implementation telemetry only. They do not alter equations,
units, tolerances, boundary conditions, or solver choices.

## 4. API, IR, and planner impact

- Python API: no public physics API change.
- `ProblemIR`: no change.
- Planner: no change.
- Native C ABI: extend `fullmag_fem_step_stats` with setup/apply/reuse fields.
- Rust runner: carry fields through `StepStats` and `StepDiagnostics`.
- Artifacts: include the latest setup/apply/reuse values in
  `metadata.json -> demag_runtime`.
- Benchmark CSV: include millisecond columns for setup/apply and a reuse flag.

## 5. Validation strategy

Local source validation:

1. C FFI binding test proves new ABI fields exist and default to zero.
2. `StepStats` diagnostic conversion preserves setup/apply/reuse fields.
3. Artifact metadata test proves `demag_runtime.timings_ns` includes setup and
   linear solver apply timings plus the reuse flag.
4. Python benchmark tests prove CSV rows can carry setup/apply/reuse from
   metadata.

Runtime validation:

1. Run CPU `exchange_demag` outside the sandbox because Open MPI/PMIx socket
   init is blocked in the default sandbox.
2. Confirm `status=ok`.
3. Confirm CSV includes `demag_solver_setup_wall_time_ms`,
   `demag_solver_apply_wall_time_ms`, and `demag_solver_setup_reused`.

The validated CPU smoke after rebuilding the managed FEM runtime produced
`status=ok` rows with the new columns present. The 2-step coarse
`exchange_demag` smoke reported the final timed step as reused setup with
`demag_solver_setup_wall_time_ms=0.0` and
`demag_solver_apply_wall_time_ms=223.84641`.

## 6. Completeness checklist

- [x] Native C ABI fields added.
- [x] Native Hypre setup/apply/reuse timings recorded.
- [x] Rust FFI and runner fields added.
- [x] Diagnostics and metadata carry fields.
- [x] Benchmark CSV carries fields.
- [x] Unit tests pass.
- [x] Unsandboxed CPU demag smoke includes setup/apply/reuse telemetry.
