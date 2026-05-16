# Native FEM CPU Demag Hot-Path Profile

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related physics notes:
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0533-fem-mfem-runtime-preflight-and-benchmark-gate.md`
- Related report:
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`

## 1. Problem statement

The FEM CPU report requires a benchmarkable Poisson-demag CPU baseline with
separate timings for:

```text
assemble RHS -> solve Poisson -> recover H_demag -> compute demag energy
```

The native backend already measures aggregate demag wall time and logs
assemble/solve/recover to stderr when detailed profiling is enabled, but those
phase timings are not part of `StepStats`, diagnostics, or artifact metadata.
That makes CPU benchmark CSV/JSON postprocessing depend on logs instead of the
runtime contract.

## 2. Physical model

No physics changes. The demagnetizing field remains:

```text
H_demag = -grad(u)
```

with `u` solved by the existing Poisson Dirichlet or Poisson Robin FEM
realization. The demag energy remains:

```text
E_demag = -0.5 mu0 sum_i Ms_i (m_i . H_demag_i) M_lumped_i + E_robin_boundary
```

where the Robin boundary term is included only for the existing Robin
realization.

## 3. Runtime interpretation

Each native FEM CPU step must expose non-physics performance telemetry:

- `demag_assemble_wall_time_ns`
- `demag_solve_wall_time_ns`
- `demag_recover_wall_time_ns`
- `demag_energy_wall_time_ns`

The aggregate `demag_wall_time_ns` remains the outer demag phase wall time.
The detailed fields are additive diagnostic evidence for benchmarking; they do
not drive solver decisions.

## 4. API, IR, and planner impact

- Python API: no change.
- `ProblemIR`: no change.
- Planner: no change.
- Native C ABI: add phase timing fields to `fullmag_fem_step_stats`.
- Rust runner: carry fields through `StepStats` and `StepDiagnostics`.
- Artifacts: include the latest demag timing breakdown in `metadata.json`
  under `demag_runtime`.

## 5. Validation strategy

Local validation does not require an MFEM host for the ABI/wrapper contract:

1. FFI binding test proves the new ABI fields exist.
2. `StepStats` diagnostic conversion preserves the new timing fields.
3. Runner native wrapper maps C ABI timing fields into `StepStats`.
4. `git diff --check` passes.

Full numerical runtime values still require an MFEM/hypre host and are deferred
to the CPU benchmark matrix.

## 6. Completeness checklist

- [x] Native C ABI fields added.
- [x] Phase timers accumulate assemble, solve, recover, and energy timings.
- [x] Rust FFI bindings include fields.
- [x] Runner `StepStats` includes fields.
- [x] Diagnostics and metadata carry fields.
- [x] Local ABI/wrapper tests pass.
- [x] MFEM-host runtime timing smoke remains explicitly deferred when MFEM is absent.
