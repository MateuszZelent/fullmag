# FEM MFEM Preflight Design

- Status: approved
- Date: 2026-05-15
- Scope: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md` Etap 3 pre-benchmark gate

## Goal

Add a deterministic preflight gate to the FEM benchmark harness so missing
MFEM/prebuilt-native-library setup is reported before benchmark execution, with
actionable remediation instead of late CMake/package-discovery failures.

## Architecture

The benchmark harness already owns the CPU/GPU sweep matrix and CSV export.
The preflight belongs there because it protects measurement validity, not the
physical FEM model.

The implementation should add pure Python helpers to
`scripts/analysis/fem_gpu_benchmark.py`:

- inspect `FULLMAG_FEM_LIB_DIR` for a prebuilt native FEM shared library,
- treat `FULLMAG_USE_MFEM_STACK=ON` as an explicit required-stack request,
- inspect `MFEM_PREFIX`, `MFEM_DIR`, and `CMAKE_PREFIX_PATH` for
  `MFEMConfig.cmake` or `mfem-config.cmake`,
- emit a machine-readable preflight summary,
- fail with exit code `2` when `--require-mfem-stack` is requested and no valid
  prebuilt/MFEM setup is found.

The normal benchmark sweep may print preflight status, but the hard gate is
explicit through `--preflight-only --require-mfem-stack` or
`--require-mfem-stack` before a benchmark run. This keeps the existing CSV
script usable for dry inventory on machines without native FEM installed while
giving CI/performance hosts a strict readiness command.

## Search Contract

The preflight searches these inputs:

1. `FULLMAG_FEM_LIB_DIR`
   - accepts `libfullmag_fem.so`, `libfullmag_fem.dylib`, or
     `fullmag_fem.dll`,
   - returns `invalid_prebuilt` when the variable is set but no expected
     library exists.
2. `FULLMAG_USE_MFEM_STACK`
   - values `1`, `ON`, `true`, and `yes` make a missing MFEM/prebuilt setup a
     gate failure even when `--require-mfem-stack` was not passed.
3. `MFEM_PREFIX`
4. `MFEM_DIR`
5. `CMAKE_PREFIX_PATH`, split by `os.pathsep`

For each MFEM prefix it checks common package-config locations:

- `<prefix>/MFEMConfig.cmake`
- `<prefix>/mfem-config.cmake`
- `<prefix>/lib/cmake/mfem/MFEMConfig.cmake`
- `<prefix>/lib/cmake/mfem/mfem-config.cmake`
- `<prefix>/lib64/cmake/mfem/MFEMConfig.cmake`
- `<prefix>/lib64/cmake/mfem/mfem-config.cmake`
- `<prefix>/share/mfem/cmake/MFEMConfig.cmake`
- `<prefix>/share/mfem/cmake/mfem-config.cmake`

## Non-Goals

This slice does not:

- compile MFEM,
- install CUDA/libCEED/Hypre,
- change native FEM equations,
- change runtime provenance,
- run long benchmarks on the current non-MFEM host.

## Validation

The validation layer is intentionally small and deterministic:

- unit tests construct temporary MFEM/prebuilt library layouts,
- a RED test must fail before production helpers exist,
- `--preflight-only` must succeed as an informational command on a missing host,
- `--preflight-only --require-mfem-stack` must fail on this host until MFEM or a
  prebuilt native FEM library is provided,
- Python files must compile cleanly.
