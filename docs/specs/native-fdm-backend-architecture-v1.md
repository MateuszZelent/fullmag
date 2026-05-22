# Native FDM Backend Architecture v1

- Status: target architecture
- Last updated: 2026-05-22
- Related reports:
  - `docs/reports/20.05.2026/backend_fdm.md`
- Related physics:
  - `docs/physics/0300-gpu-fdm-precision-and-calibration.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`
  - `docs/physics/0421-fdm-multilayer-convolution-demag.md`
  - `docs/physics/0500-fdm-relaxation-algorithms.md`

## 1. Purpose

This document is the target organization contract for the FDM backend. The
problem is not that FDM has too few features. The problem is that CPU reference
physics, runner orchestration, native CUDA state, C ABI glue, and multilayer
demag support grew in different places.

The goal is to make FDM as auditable as native FEM while preserving a key
difference: the authoritative FDM CPU reference lives in Rust, not in native
C++/CUDA.

## 2. Principles

### CPU Reference and GPU Production Share One Physics Contract

Rust CPU FDM remains the double-precision reference path. Native CUDA FDM is the
production GPU path. They may use different storage, FFT libraries, and kernels,
but signs, units, effective-field terms, torque terms, observables, artifact
names, and provenance must not drift.

### Folders Follow Ownership, Not Just Device Labels

The target layout separates:

1. shared FDM problem semantics,
2. Rust CPU reference execution,
3. runner/runtime orchestration,
4. native CUDA state and kernels,
5. C ABI compatibility,
6. multilayer demag subsystem.

Moving files without extracting an owner contract does not complete this
architecture.

### Native CUDA Is a Backend, Not the Public Model

`native/backends/fdm` owns CUDA memory, streams, cuFFT plans, device reductions,
and kernel launch wiring. It must not redefine public FDM semantics already
owned by physics notes, ProblemIR, the Rust CPU reference, or the C ABI.

### Multilayer Demag Is a First-Class Subsystem

Single-grid demag and multilayer convolution are different execution shapes.
The target architecture must not hide multilayer transfer maps, shifted
kernels, per-layer descriptors, or ABI v2 behind ad hoc runner glue.

The current native CUDA boundary stages v2 layers and tensor kernels in
`Context`, owns identity-grid `push_m`, tensor multiply, and `pull_h` kernels
under `cuda/demag/multilayer_convolution.cu`, prepares a shared cuFFT
workspace when all staged layer-pair kernels use one `fft_grid`, and rejects v2
handles from the legacy single-grid `step()` path after refreshing native
multilayer demag for demag-enabled v2 plans. Full multilayer timestep execution
remains unwired.

## 3. Current Strangler Boundary

The first accepted layout step is the Rust engine move:

```text
crates/fullmag-engine/src/fdm/
  mod.rs
  demo.rs
  fft.rs
  fft_backend.rs
  fields.rs
  integrators.rs
  problem.rs
  state.rs
  types.rs
```

The crate root may temporarily keep compatibility modules such as
`fdm_problem`, `fdm_fields`, and `fdm_fft_backend` so existing callers can
compile while imports are migrated.

## 4. Target Rust Layout

The target Rust control-plane and CPU-reference layout is:

```text
crates/fullmag-engine/src/fdm/
  mod.rs
  shared/
    types.rs
    problem.rs
    terms.rs
    observables.rs
  cpu/
    state.rs
    fields.rs
    integrators.rs
    fft.rs
    fft_backend.rs
    minimizers.rs
  validation/
    standard_problems.rs
    parity.rs

crates/fullmag-runner/src/fdm/
  mod.rs
  cpu_reference.rs
  native_cuda.rs
  interactive.rs
  artifacts.rs
  schedules.rs
  multilayer.rs
```

This layout is descriptive. It should be reached in small, compiling moves that
preserve old public imports until all internal callers are migrated.

## 5. Target Native Layout

The target native CUDA layout is:

```text
native/backends/fdm/
  include/
    context.hpp
    kernels.hpp
    result.hpp
  core/
    context.cu
    plan_fields.hpp/.cpp
    field_buffers.hpp/.cpp
    material_fields.hpp/.cpp
    state.hpp/.cpp
    snapshots.hpp/.cpp
    telemetry.hpp/.cpp
  cuda/
    runtime/
      device_info.cpp
      streams.cu
      reductions_fp64.cu
    interactions/
      exchange_fp64.cu
      exchange_fp32.cu
      exchange_t0_fp64.cu
      exchange_t1_fp64.cu
      demag_fp64.cu
      demag_fp32.cu
      demag_boundary_fp64.cu
      dmi_fp64.cu
      dmi_fp32.cu
    integrators/
      llg_fp64.cu
      llg_fp32.cu
      llg_rk23_fp64.cu
      llg_rk23_fp32.cu
      llg_rk4_fp64.cu
      llg_rk4_fp32.cu
      llg_dp45_fp64.cu
      llg_dp45_fp32.cu
      llg_abm3_fp64.cu
      llg_abm3_fp32.cu
    demag/
      newell_gpu_fp64.cu
      newell_gpu_fp32.cu
      multilayer_transfer.cu
      multilayer_multiply.cu
  api/
    c_api.cpp
    error.cpp
  tests/
```

The former flat `src/` directory is no longer the owner for native FDM source
files. New native FDM subsystems should land in the target owner directory
instead of making `core/context.cu` or `api/c_api.cpp` larger.

## 6. Required Contract Tests

FDM should gain source-level contract tests matching the FEM modularization
style:

- `fullmag-engine` exposes `fdm/` as the real Rust engine module and keeps old
  `fdm_*` modules as compatibility shims only.
- `native/backends/fdm/api/c_api.cpp` owns ABI translation, not physics kernels.
- `native/backends/fdm/core/context.cu` owns compatibility state allocation, not
  interaction formulas.
- native demag, exchange, integrators, reductions, and snapshots each have a
  stable owner path before further expansion.
- `multilayer_abi_v2_contract` proves the C header and Rust FFI expose
  `fullmag_fdm_plan_kind`, per-layer descriptors, tensor-kernel descriptors,
  and a multilayer plan descriptor before native CUDA execution is wired.
- `multilayer_create_v2_contract` proves `fullmag_fdm_backend_create_v2`
  validates malformed multilayer plans and returns an explicit unsupported
  status for valid plans until native execution exists.
- The same contract, together with the ABI source contract, proves validated
  v2 plans are staged into `Context` as per-layer magnetization/mask buffers
  and per-pair tensor-kernel device buffers before execution is reported
  unsupported.
- multilayer demag has one subsystem boundary across Rust runner, Rust demag
  crate, and native CUDA ABI v2.

## 7. Validation

Each migration slice must run at least the narrowest check that proves behavior
did not change:

- Rust engine moves: `cargo check -p fullmag-engine`.
- Runner moves: `cargo test -p fullmag-runner --lib` for affected runtime
  paths.
- Native CUDA moves: build `fullmag_fdm` and run the matching contract test.
- Cross-boundary moves: run the relevant physics parity or benchmark gate before
  claiming production readiness.
