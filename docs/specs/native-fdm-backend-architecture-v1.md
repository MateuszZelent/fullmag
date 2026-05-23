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
under `gpu/cuda/demag/multilayer_convolution.cu`, owns cached multilayer cuFFT
workspaces keyed by tensor-kernel `fft_grid`, binds the active workspace before
each tensor-kernel launch, and rejects v2 handles from the legacy single-grid
`step()` path. A dedicated
`fullmag_fdm_backend_refresh_multilayer_demag` ABI refreshes native multilayer
demag for demag-enabled v2 plans without pretending to advance time. The
identity-grid v2 demag operator must forward-transform and inverse-transform
all three vector components, not only `M_x`, before tensor multiply and
pull-back. Identity transfer means `native_grid == convolution_grid`; the
tensor-kernel `fft_grid` may be padded, and must only contain the convolution
grid with matching cell size. The v2 layer descriptor now carries explicit
`transfer_kind`, and native staging preserves `identity` versus `push_pull`
instead of inferring transfer semantics from the grid sizes. The staged v2
demag refresh now has fp64/fp32 native CUDA `push_pull` kernels with the same V1
semantics as the Rust demag crate: volume-weighted native-to-convolution
`push_m` and trilinear convolution-to-native `pull_h`. Native v2 upload now
precomputes staged transfer maps in `Context`: sparse push offsets, native
indices, weights, and padded-FFT pull indices/weights. The map ownership
boundary is asymmetric: push maps are per source layer because they depend only
on native/convolution grids, while pull maps are per tensor kernel because they
index the active padded `fft_grid`. These maps are the correctness boundary for
heterogeneous-grid refresh; optimized hardware interpolation remains future
performance work. Per-layer `M`, `H_EX`, and
`H_DEMAG` copy entrypoints expose that refreshed state through the C ABI and
Rust FFI, and
per-layer magnetization upload lets the CUDA-assisted multilayer runner use the
native v2 handle as an identity-grid demag operator. The
`gpu/cuda/interactions/multilayer_exchange.cu` owner provides the first layer-local
v2 exchange field slice: a uniform-A six-neighbor stencil on each layer native
grid, with open Neumann boundary clamping and active-mask clamping. The
`gpu/cuda/integrators/multilayer_heun.cu` and
`gpu/cuda/integrators/multilayer_rk4.cu` owners provide the first native v2
timestep slices: Heun and RK4 for staged multilayer layers in fp64/fp32, using
per-layer `tmp`, `k1`, `k2`, `k3`, and `k4` buffers with demag plus
the requested uniform external field, per-layer uniform uniaxial anisotropy,
per-layer uniform cubic anisotropy, global interfacial/bulk DMI, and
layer-local exchange. Local-field RHS coverage beyond uniform external field,
per-layer uniform uniaxial/cubic anisotropy, global DMI, and layer-local exchange,
optimized interpolation, and adaptive/multistep v2 integrators remain explicit
future work.
The public multilayer planner and CUDA-assisted multilayer runner may carry
fixed-step RK4 to this native v2 boundary; adaptive and multistep v2 integrators
remain rejected instead of falling back into single-grid execution.
For CPU-reference multilayer execution the public planner keeps the wider
fixed-step CPU contract: Heun, RK4, RK23, RK45, and ABM3 may lower when CUDA is
not explicitly requested. The narrower Heun/RK4 gate applies only to explicit
CUDA/native v2 multilayer execution.

Native step diagnostics now have a dedicated CUDA runtime owner in
`gpu/cuda/runtime/telemetry.cu`. The C ABI requests current stats through
`Context`; it no longer owns the energy-reduction and field-amplitude wiring
directly.
CUDA stream lifecycle and legacy-default/compute-stream handoff are owned by
`gpu/cuda/runtime/streams.cu`, so `gpu/cuda/runtime/context.cu` keeps stream
pointers as state without owning runtime scheduling policy.

## 3. Current Strangler Boundary

The first accepted layout step is the Rust engine move:

```text
crates/fullmag-engine/src/fdm/
  mod.rs
  demo.rs
  shared/
    mod.rs
    observables.rs
    problem.rs
    terms.rs
    types.rs
    vector_field.rs
  cpu/
    mod.rs
    fft.rs
    fft_backend.rs
    fields.rs
    integrators.rs
    state.rs
```

The crate root and `fdm/mod.rs` may temporarily keep compatibility modules such
as `fdm_fft`, `fdm_types`, `fdm_fft_backend`, `fdm::fft`, and `fdm::state` so
existing callers can compile while imports are migrated.

The second accepted layout step is the runner FDM owner module:

```text
crates/fullmag-runner/src/fdm/
  mod.rs
  artifacts.rs
  cpu/
    mod.rs
    reference.rs
    multilayer_reference.rs
  gpu/
    mod.rs
    cuda/
      mod.rs
      native.rs
      multilayer.rs
  multilayer.rs
  schedules.rs
```

Internal runner callers now import these paths through their FDM owner modules
directly. The old private compatibility modules
`crate::cpu_reference`, `crate::multilayer_cuda`, `crate::multilayer_reference`,
and `crate::native_fdm` are no longer allowed in `src/lib.rs`.

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
  artifacts.rs
  schedules.rs
  multilayer.rs
  cpu/
    reference.rs
    multilayer_reference.rs
  gpu/cuda/
    native.rs
    multilayer.rs
  interactive.rs
```

This layout is descriptive. It should be reached in small, compiling moves.
Internal runner call sites must use the owner modules directly instead of
root-level FDM compatibility shims.

## 5. Target Native Layout

The target FDM implementation layout is explicit about the CPU/GPU split:
the CPU reference implementation lives in Rust under
`crates/fullmag-engine/src/fdm/cpu`, while the native production GPU backend
lives under `native/backends/fdm/gpu/cuda`.

The target native GPU/CUDA layout is:

```text
native/backends/fdm/
  include/
    context.hpp
    kernels.hpp
    result.hpp
  core/
    plan_fields.hpp/.cpp
    field_buffers.hpp/.cpp
    material_fields.hpp/.cpp
    state.hpp/.cpp
    snapshots.hpp/.cpp
  gpu/cuda/
    runtime/
      context.cu
      telemetry.cu
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
instead of making `gpu/cuda/runtime/context.cu` or `api/c_api.cpp` larger.

## 6. Required Contract Tests

FDM should gain source-level contract tests matching the FEM modularization
style:

- `fullmag-engine` exposes `fdm/` as the real Rust engine module and keeps old
  `fdm_*` modules as compatibility shims only.
- `VectorFieldSoA` is owned by `fdm/shared/vector_field.rs`, not by the crate
  root.
- Shared FDM problem semantics are owned by `fdm/shared/problem.rs`,
  observables and step-report contracts by `fdm/shared/observables.rs`,
  field-term semantics by `fdm/shared/terms.rs`, and scalar FDM types by
  `fdm/shared/types.rs`, not by the flat `fdm/` root.
- CPU execution files are owned by `fdm/cpu/` (`fft`, `fft_backend`, `fields`,
  `integrators`, and `state`), not by the flat `fdm/` root.
- `fullmag-runner` keeps FDM CPU reference, multilayer reference, CUDA-assisted
  multilayer, native CUDA wrapper sources, shared FDM artifact helpers, and
  shared multilayer stats/schedule helpers under `src/fdm/`, not as root-level
  runner modules or duplicated local helpers.
- Runner CPU implementations are owned by `src/fdm/cpu/`; runner CUDA
  implementations are owned by `src/fdm/gpu/cuda/`. The old
  `src/fdm/cpu_reference.rs`, `src/fdm/multilayer_reference.rs`,
  `src/fdm/native_cuda.rs`, and `src/fdm/multilayer_cuda.rs` files are no
  longer owner paths.
- `native/backends/fdm/api/c_api.cpp` owns ABI translation, not physics kernels.
- `native/backends/fdm/gpu/cuda/runtime/context.cu` owns CUDA compatibility
  state allocation, not interaction formulas.
- native demag, exchange, integrators, reductions, telemetry, and snapshots
  each have a stable owner path before further expansion.
- `gpu/cuda/runtime/streams.cu` owns compute-stream creation, destruction, and
  default-stream handoff helpers; `gpu/cuda/runtime/context.cu` must call those
  helpers rather than defining runtime stream policy inline.
- `multilayer_abi_v2_contract` proves the C header and Rust FFI expose
  `fullmag_fdm_plan_kind`, per-layer descriptors, tensor-kernel descriptors,
  and a multilayer plan descriptor before native CUDA execution is wired.
- `multilayer_create_v2_contract` proves `fullmag_fdm_backend_create_v2`
  validates malformed multilayer plans and exposes the native v2 staged
  execution scope for valid plans.
- The same contract, together with the ABI source contract, proves validated
  v2 plans are staged into `Context` as per-layer magnetization/mask buffers
  and per-pair tensor-kernel device buffers before execution.
- The ABI source contract proves v2 handles expose per-layer `M`, `H_EX`,
  `H_DEMAG`, `H_DMI`, `H_ANI`, `H_EXT`, and scratch-backed `H_EFF` copy
  entrypoints and route them through `Context`, rather than through the legacy
  single-grid field copy path. The same contract keeps the public C header
  documentation aligned with that observable set and prevents stale
  "multilayer CUDA not implemented" placeholder wording from returning as an
  accepted staged status.
- The ABI source contract also proves v2 handles expose per-layer
  magnetization upload, and that the Rust runner wrapper can build
  `fullmag_fdm_multilayer_plan_desc_v2` plus upload/copy per-layer state.
- The ABI source contract proves v2 handles expose an explicit
  `fullmag_fdm_backend_refresh_multilayer_demag` entrypoint, and that the Rust
  runner wrapper uses it instead of driving demag refresh through `step(0)`.
- The ABI source contract proves native identity-grid multilayer demag runs
  forward and inverse cuFFT on `fft_x`, `fft_y`, and `fft_z` before exposing
  refreshed `H_DEMAG`.
- The ABI source contract proves native identity-grid transfer accepts padded
  FFT grids while still rejecting cases where native and convolution grids
  differ and require real transfer maps.
- The ABI source contract proves `transfer_kind` is explicit across the C ABI,
  Rust FFI, Rust runner wrapper, and native staged layer state, and that
  `push_pull` has fp64/fp32 native CUDA push/pull transfer kernels rather than a
  native unsupported placeholder.
- The ABI source contract proves staged v2 `step()` routes to
  `launch_multilayer_heun_step_fp64/fp32` and
  `launch_multilayer_rk4_step_fp64/fp32`, and that Heun/RK4 owners are compiled
  from `gpu/cuda/integrators/multilayer_heun.cu` and
  `gpu/cuda/integrators/multilayer_rk4.cu` instead of keeping the old
  timestep-unsupported placeholder.
- The ABI source contract proves staged v2 Heun does not reject exchange-enabled
  plans, compiles `gpu/cuda/interactions/multilayer_exchange.cu`, and stores
  per-layer `H_EX` separately from `H_DEMAG`.
- The ABI source contract proves staged v2 multilayer plans carry the requested
  uniform external field through the C ABI, Rust FFI, Rust native runner
  wrapper, native `Context`, and Heun/RK4 RHS kernels.
- The ABI source contract proves staged v2 layer descriptors carry per-layer
  uniform uniaxial anisotropy (`Ku1`, `Ku2`, axis) through the C ABI, Rust FFI,
  Rust native runner wrapper, native staged layer state, and Heun/RK4 RHS
  kernels.
- The ABI source contract proves staged v2 layer descriptors carry per-layer
  uniform cubic anisotropy (`Kc1`, `Kc2`, `Kc3`, axes) through the C ABI, Rust
  FFI, Rust native runner wrapper, native staged layer state, and Heun/RK4 RHS
  kernels.
- The planner and ABI source contracts prove staged v2 multilayer plans carry
  global interfacial/bulk DMI constants through `FdmMultilayerPlanIR`, the C
  ABI, Rust FFI, Rust native runner wrapper, native `Context`, and Heun/RK4 RHS
  kernels.
- The runner stats contract proves `cuda_native_multilayer_single_grid` keeps
  native timestep metadata but derives scalar/live/relaxation `StepStats` from
  per-layer `StateObservables`, not from a single combined-grid scalar record.
- The artifact contract proves FDM multilayer field snapshots are written as a
  per-layer series with `fields/<quantity>/manifest.json`, stable layer IDs,
  native origins, vector shape, value offsets, and layer subdirectories instead
  of one anonymous combined-grid field file.
- The artifact unit contract proves component snapshots such as `m.x` and
  `H_eff.z` inherit their base observable units, and that vector `torque`
  artifacts use the Tesla-style preview payload while scalar relaxation
  convergence keeps `max_torque_Apm` as the canonical stop unit.
- multilayer demag has one subsystem boundary across Rust runner, Rust demag
  crate, and native CUDA ABI v2.

## 7. Validation

Each migration slice must run at least the narrowest check that proves behavior
did not change:

- Rust engine moves: `cargo check -p fullmag-engine`.
- Rust FDM layout moves: `cargo test -p fullmag-engine --test
  fdm_source_layout_contract` and `cargo test -p fullmag-runner --test
  fdm_source_layout_contract`.
- Runner moves: `cargo test -p fullmag-runner --lib` for affected runtime
  paths.
- Native CUDA moves: build `fullmag_fdm` and run the matching contract test.
- Cross-boundary moves: run the relevant physics parity or benchmark gate before
  claiming production readiness.
