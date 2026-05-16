# Native FEM CPU Demag Recovery Workspace

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-16
- Related ADRs: none
- Related specs:
  - `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`

## 1. Problem statement

Native FEM Poisson demag recovery currently computes `H_demag = -grad(u)` by a
CPU element loop. For each demag solve it allocates:

- the full-domain output field,
- a node-weight vector,
- optional per-thread field and weight partials for OpenMP recovery,
- temporary MFEM element buffers.

The equations are correct for the current airbox Poisson bootstrap, but the
allocation pattern is still a hot-path cost. This note scopes the next CPU-only
optimization: reuse recovery scratch storage across demag solves on the same
native FEM context.

## 2. Physical model

### 2.1 Governing equations

No physics change. The scalar potential `u` is solved by the existing FEM
Poisson demag realization:

```text
integral_Omega grad(u) . grad(v) dV = integral_Omega_m M . grad(v) dV
H_demag = -grad(u)
```

The recovered nodal field remains the existing quadrature-weighted nodal
average of element gradients. The demag energy remains:

```text
E_demag = -0.5 mu0 sum_i Ms_i (m_i . H_demag_i) M_lumped_i + E_robin_boundary
```

where `E_robin_boundary` is included only for the existing Robin airbox
realization.

### 2.2 Symbols and SI units

- `u`: magnetic scalar potential, units A.
- `H_demag`: demagnetizing field, A/m.
- `M = Ms m`: magnetization, A/m.
- `Ms`: saturation magnetization, A/m.
- `m`: unit magnetization vector, dimensionless.
- `mu0`: vacuum permeability, H/m.
- `M_lumped_i`: nodal lumped mass/volume, m^3.
- `E_demag`: demag energy, J.

### 2.3 Assumptions and approximations

The current airbox Dirichlet/Robin boundary approximation remains unchanged.
The field recovery remains host-side and assembled-sparse. This is not a
libCEED, partial-assembly, or device-side recovery implementation.

## 3. Numerical interpretation

### 3.1 FDM

No impact.

### 3.2 FEM

The FEM recovery algorithm is unchanged:

1. build a `GridFunction` for the scalar potential from true DOFs,
2. loop over elements and quadrature points,
3. compute `grad(u)`,
4. distribute `-grad(u)` to nodal accumulators with shape-function weights,
5. normalize by accumulated nodal weights,
6. preserve a full-domain visualization field,
7. zero non-magnetic nodes for LLG and energy.

Only scratch ownership changes. The context owns reusable recovery buffers sized
for the current mesh and selected recovery thread count.

### 3.3 Hybrid

No impact.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public API change.

### 4.2 ProblemIR representation

No `ProblemIR` change.

### 4.3 Planner and capability-matrix impact

No planner or capability change. Runtime provenance remains truthful:
`fem_assembly_mode = legacy_sparse` and `fem_data_residency =
host_source_of_truth` for the current CPU path.

## 5. Validation strategy

### 5.1 Analytical checks

No new analytical result is needed because the recovered field formula is
unchanged.

### 5.2 Cross-backend checks

No cross-backend behavior changes in this slice.

### 5.3 Regression tests

1. Add a source-level guard proving `recover_demag_poisson_field` no longer creates
   per-call full-size partial vectors in the function body.
2. Compile the native FEM FFI path with `cargo check -p fullmag-cli --features
   "cuda fem-gpu"`.
3. Rebuild the managed FEM runtime bundle.
4. Run an unsandboxed CPU `exchange_demag` smoke and confirm `status=completed`.
5. Run a CPU benchmark CSV smoke and confirm `status=ok` with demag recovery
   timings still populated.

## 6. Completeness checklist

- [x] Python API unaffected.
- [x] ProblemIR unaffected.
- [x] Planner unaffected.
- [x] Capability matrix unaffected.
- [x] FDM backend unaffected.
- [x] FEM backend uses context-owned recovery scratch.
- [x] Hybrid backend unaffected.
- [x] Outputs / observables unchanged.
- [x] Tests / benchmarks pass.
- [x] Documentation updated.

## 7. Known limits and deferred work

- Recovery remains host-side.
- The next larger optimization is a true MFEM operator/projection, partial
  assembly, or libCEED/device-side recovery path.
- Hypre vector transfer remains host-copy based in this slice.

## 8. Validation evidence

- `cargo test -p fullmag-runner native_fem_demag_recovery_reuses_context_workspace --features fem-gpu -- --nocapture`: passed after the RED run failed on the missing context-owned workspace.
- `cargo check -p fullmag-cli --features "cuda fem-gpu"`: passed.
- `just rebuild-fem-runtime`: rebuilt the managed FEM runtime bundle with the C++ recovery workspace.
- `python3 scripts/analysis/fem_gpu_benchmark.py --backends cpu --meshes coarse --scenarios exchange_demag --integrators heun --steps 1 --output /tmp/fullmag_fem_cpu_demag_recovery_workspace_smoke.csv --require-mfem-stack`: passed with `status=ok`, `demag_recover_wall_time_ms=6.778059`, and unchanged `fem_execution_mode=cpu_native`.

## 9. References

- `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
