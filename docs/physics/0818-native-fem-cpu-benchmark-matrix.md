# Native FEM CPU Benchmark Matrix

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related report:
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`
- Related notes:
  - `docs/physics/0816-native-fem-cpu-availability-contract.md`
  - `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`

## 1. Problem statement

The FEM CPU report requires a CPU baseline before any GPU audit or comparison.
The existing benchmark harness can run CPU and GPU paths, but the CPU lane must
be selectable by itself and must export the detailed demag timings needed for
post-processing.

## 2. Physical model

No physics changes. The benchmark matrix exercises existing problem definitions:

- exchange-only LLG,
- exchange plus Poisson demag,
- exchange plus DMI,
- STT/Oersted.

The demag model remains the existing FEM Poisson Dirichlet or Robin realization.
This note only defines benchmark observability.

## 3. Runtime and artifact contract

CPU benchmark rows must include:

- resolved backend id and execution mode,
- actual solver mesh node and element counts,
- integrator,
- wall time and RHS evaluation count,
- demag solve count, iterations, residual,
- exchange and demag phase timings,
- detailed demag timings:
  - `demag_assemble_wall_time_ns`,
  - `demag_solve_wall_time_ns`,
  - `demag_recover_wall_time_ns`,
  - `demag_energy_wall_time_ns`,
- requested and effective OpenMP thread counts.

The benchmark harness must support a CPU-only run mode so the CPU baseline can
be collected without running or qualifying GPU paths.

## 4. API, IR, and planner impact

- Python DSL: no public physics API change.
- `ProblemIR`: no change.
- Planner: no change.
- Runtime: no new solver decision.
- Benchmark scripts: add CPU-only backend selection and carry detailed demag
  timing fields from result payloads or metadata.
- Benchmark scripts: when runtime metadata contains an FEM execution plan, prefer
  the plan mesh name and counts over the input mesh file. This matters for
  `exchange_demag`, where the script builds a generated shared-domain mesh with
  air rather than using the magnetic-only preset mesh directly.
- Benchmark scripts: when runtime metadata contains an FEM execution-plan mesh,
  emit a stable `solver_mesh_signature` hash of the actual solver mesh
  topology/coordinates. This prevents comparing demag solve timings across
  different generated meshes as if they were the same benchmark case.
- Benchmark scripts: when an accepted baseline CSV is supplied, compare only
  rows with matching `solver_mesh_signature` and logical benchmark case. A row
  fails the performance gate when wall-clock or demag timing metrics regress by
  more than the configured threshold, defaulting to 10%.

## 5. Validation strategy

Local validation can verify the benchmark contract without an MFEM host:

1. Unit tests prove benchmark summaries include detailed demag timing fields.
2. Unit tests prove benchmark CSV rows carry detailed timings from payload or
   `metadata.json`.
3. Unit tests prove `--backends cpu` resolves only the CPU lane.
4. Unit tests prove generated shared-domain demag rows can use solver mesh
   counts from `metadata.json`.
5. `py_compile` validates the benchmark scripts.

Local sandbox smoke can verify CPU-only `exchange_only` execution when a
prebuilt native FEM library is available. `exchange_demag` materializes the
generated shared-domain mesh and resolves to `fem_cpu_native`; inside the normal
sandbox it is blocked by Open MPI/PMIx socket initialization during
`MPI_Init_thread`, but the same benchmark succeeds when run outside the sandbox.
The analysis runner therefore loads `metadata.json` from the CLI-reported
`artifact_dir` so CLI workspace summaries still produce rows with solver mesh
stats, demag timings, solver iterations, and residuals.

## 6. Completeness checklist

- [x] Benchmark summary emits detailed demag timings.
- [x] Analysis runner writes detailed demag timings into CSV rows.
- [x] Analysis runner supports CPU-only backend selection.
- [x] `exchange_demag` benchmark authoring uses generated shared-domain mesh.
- [x] Analysis runner prefers actual FEM execution-plan mesh counts when
      metadata is available.
- [x] Analysis runner emits `solver_mesh_signature` for execution-plan meshes.
- [x] Analysis runner loads metadata from CLI `artifact_dir` summaries.
- [x] Analysis runner can compare against an accepted baseline CSV and fail
      timing regressions above 10% for identical `solver_mesh_signature` cases.
- [x] Local CPU/harness tests and `py_compile` pass.
- [x] Report records sandbox MPI limitations and the successful unsandboxed
      CPU demag smoke.
