# FEM MFEM runtime preflight and benchmark gate

- Status: implemented
- Owners: Fullmag FEM/runtime
- Last updated: 2026-05-15
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/superpowers/specs/2026-05-15-fem-mfem-preflight-design.md`

## 1. Problem statement

Production FEM optimization work needs a deterministic way to distinguish a
real solver regression from a missing MFEM/libCEED/Hypre/CUDA host setup.

The native MFEM path currently depends on external package configuration or a
prebuilt Fullmag FEM library. When the host does not expose those inputs, CMake
fails late with package-discovery errors. That is not a physics failure and it
must not be treated as benchmark evidence.

## 2. Physical model

### 2.1 Governing equations

No physical equation changes in this slice.

The benchmark preflight only checks whether the host can build or run the
already-defined native FEM realization of the micromagnetic problem. Existing
FEM equations remain governed by the corresponding notes:

- exchange: `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
- demag: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- DMI: `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md` and
  `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`

### 2.2 Symbols and SI units

No new SI quantity is introduced.

The preflight status is a runtime/build-environment diagnostic. It has no unit
and must not be serialized as a physical observable.

### 2.3 Assumptions and approximations

- `FULLMAG_FEM_LIB_DIR` points to a usable prebuilt Fullmag FEM library.
- `MFEM_DIR`, `MFEM_PREFIX`, or `CMAKE_PREFIX_PATH` may point to an MFEM
  package config directory or install prefix.
- `FULLMAG_USE_MFEM_STACK=ON` means the native build must discover MFEM through
  CMake package config before benchmark claims are valid.
- CUDA/libCEED availability remains a stricter runtime capability than generic
  MFEM package discovery. This slice reports the MFEM gate first and leaves
  deeper device qualification to the existing FEM GPU enablement scripts and
  benchmark runs.

## 3. Numerical interpretation

### 3.1 FDM

No change. FDM CUDA benchmarks may still be used as a separate reference, but
this preflight gate applies to native FEM/MFEM only.

### 3.2 FEM

The FEM benchmark harness must be able to report one of these host states before
running long measurements:

- `ok_prebuilt`: `FULLMAG_FEM_LIB_DIR` exposes a prebuilt native FEM library.
- `ok_mfem_config`: an MFEM CMake package config was found.
- `missing`: neither a prebuilt library nor an MFEM package config was found.
- `invalid_prebuilt`: `FULLMAG_FEM_LIB_DIR` was set but did not contain the
  expected native FEM library.

When a benchmark is run with a required MFEM stack, `missing` and
`invalid_prebuilt` are hard gate failures. The remediation must name the exact
environment variables that can make the host eligible: `FULLMAG_FEM_LIB_DIR`,
`MFEM_DIR`, `MFEM_PREFIX`, and `CMAKE_PREFIX_PATH`.

### 3.3 Hybrid

No hybrid semantics are introduced.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python DSL changes.

### 4.2 ProblemIR representation

No `ProblemIR` change. The preflight is outside the physical problem contract.

### 4.3 Planner and capability-matrix impact

No planner legality change. This is a host readiness gate for build and
benchmark scripts, not a new solver capability.

## 5. Runtime/session/artifact/provenance impact

The preflight gate must not be written as run provenance for a successful
simulation. Actual runtime provenance still comes from the native backend and
its step metadata.

Benchmark CSV rows may continue to carry runtime metadata such as
`fem_assembly_mode`, `mfem_device`, demag iteration counts, and residuals. A
failed preflight means those rows are not valid measurement rows.

## 6. Validation strategy

### 6.1 Analytical checks

None. This slice changes environment detection only.

### 6.2 Cross-backend checks

The gate prevents cross-backend speed comparisons from being reported when the
native FEM side is not actually buildable/runnable on the host.

### 6.3 Regression tests

- Unit test MFEM package-config discovery from `MFEM_DIR`.
- Unit test `CMAKE_PREFIX_PATH` search with platform path separators.
- Unit test prebuilt library validation through `FULLMAG_FEM_LIB_DIR`.
- Unit test required-stack failure reports actionable remediation when neither
  prebuilt library nor MFEM config is available.

## 7. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [x] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 8. Known limits and deferred work

- This gate does not prove partial assembly, libCEED, CUDA, or Hypre are enabled
  in the discovered MFEM installation.
- Device qualification still needs actual native tests and benchmark execution
  on an MFEM/CUDA host.
- PBC demag remains outside the current benchmark matrix until a mesh fixture
  with periodic pairs exists.

## 9. References

- `scripts/check_mfem_host_env.sh`
- `scripts/verify_fem_gpu_enablement.sh`
- `scripts/analysis/fem_gpu_benchmark.py`
- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
