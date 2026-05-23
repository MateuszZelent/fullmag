# FDM Native Staged-v2 Public Routing Design

- Status: design approved; written-spec review pending
- Date: 2026-05-23
- Scope: public heterogeneous CUDA multilayer timestep routing and runtime observability
- Out of scope: new physics terms, adaptive staged-v2 integration, RK45/ABM3 staged-v2
  ownership, CPU numerical changes, optimized `pull_h`

## Problem

The public heterogeneous CUDA multilayer route accepts fixed-step `Heun`, `RK4`,
and `RK23`, while its current timestep loop still executes the
`cuda_assisted_multilayer` Heun implementation. The native staged-v2 backend
already owns fixed-step `Heun`, `RK4`, and `RK23` kernels and per-layer field
copy endpoints, but the public heterogeneous execution route uses that handle
only as an optional demag operator.

This is a runtime-semantics defect: requested and planned `RK4` or `RK23`
execution may be reported as accepted without the corresponding staged-v2
integrator owning the public timestep.

## Decision

Public explicit-CUDA multilayer execution will have two native timestep routes:

1. Compatible stacked single-grid plans continue through
   `cuda_native_multilayer_single_grid`.
2. Heterogeneous staged-v2 plans accepted for fixed-step `Heun`, `RK4`, or
   `RK23` execute through `NativeFdmBackend::create_multilayer_v2(plan)` and
   `backend.step(dt_step)`.

`cuda_assisted_multilayer` must not remain the public timestep owner for an
integrator that staged-v2 advertises and implements. It may remain as internal
or explicitly unsupported-scope fallback code until removed by a later,
separately verified cleanup.

## Existing Numerical Boundary

This routing change exposes already-implemented staged-v2 numerical ownership;
it does not alter governing equations, SI units, discretization, or material
meaning. The routed native timestep scope remains:

- optional multilayer convolution demag, including existing `identity` and
  `push_pull` transfer semantics,
- layer-local exchange,
- uniform external field,
- per-layer uniform uniaxial and cubic anisotropy,
- global interfacial and bulk DMI,
- fixed-step `Heun`, `RK4`, and `RK23`,
- `double` and calibrated `single` precision lanes already accepted by the
  native wrapper.

Staged-v2 remains non-executable for adaptive `RK23`, `RK45`, `ABM3`, thermal
noise, Oersted terms, and spin-torque inputs until their explicit native
coverage is implemented and validated.

## Runtime Architecture

`execute_cuda_fdm_multilayer_with_live` retains the existing single-grid
eligibility check. When it does not resolve to the single-grid native path and
the staged-v2 integrator gate succeeds, it calls a new native staged-v2
execution owner instead of constructing an assisted timestep loop.

The staged-v2 execution owner:

- creates one native v2 handle from the canonical `FdmMultilayerPlanIR`,
- advances the handle with `backend.step(dt_step)`,
- preserves current artifact schedules, live callbacks, cancellation, and
  relaxation completion handling,
- computes scalar reporting from layer observables rather than treating native
  step metadata as physical per-layer scalar truth.

No new `ProblemIR` fields are required. The existing plan already carries this
fixed-step integrator and staged-v2 RHS scope. The repair is in runtime
resolution and provenance.

## Observability And Provenance

The staged-v2 runtime reads fields per layer through the existing native
wrapper endpoints:

- `M`,
- `H_EX`,
- `H_DEMAG`,
- `H_EXT`,
- `H_ANI`,
- `H_DMI`,
- `H_EFF`.

Those fields are assembled into the same runtime observable contract used for
scheduled fields, scalar traces, live updates, and final magnetization. The
runtime must preserve object-local scalar ownership for heterogeneous layers.

Resolved execution provenance will identify the native staged-v2 engine
separately from both `cuda_native_multilayer_single_grid` and
`cuda_assisted_multilayer`. For demag-enabled staged execution it reports
native multilayer tensor FFT ownership and cuFFT; it must not report the Rust
assisted demag/runtime route.

## Failure Behavior

- If an explicit CUDA heterogeneous multilayer plan requests an unsupported
  staged-v2 integrator, planning/runtime validation fails explicitly; it does
  not silently execute Heun.
- If CUDA is unavailable, the existing explicit-CUDA unavailability error
  remains authoritative.
- There is no automatic downgrade from requested staged-v2 native execution to
  assisted integration for `RK4` or `RK23`.

## Documentation And Capability Impact

Before implementation, the existing physics notes must be amended to state
that public heterogeneous explicit-CUDA fixed-step execution resolves through
the native staged-v2 timestep owner. The capability matrix and native FDM
backend architecture spec must distinguish:

- native single-grid multilayer execution,
- native staged-v2 heterogeneous execution,
- any remaining assisted code that is not a legal hidden substitute for the
  requested integrator.

No Python DSL, OpenAPI, UI, or serialization changes are required because the
public integrator/device vocabulary does not change.

## Verification

Verification for this slice consists of:

1. A RED runner/source contract showing that a heterogeneous `RK23` public
   plan does not yet route to a native staged-v2 timestep owner.
2. A passing routing contract after implementation requiring
   `create_multilayer_v2(plan)` and `backend.step(dt_step)` in the selected
   heterogeneous execution path, with distinct native staged provenance.
3. A runner compile check with CUDA enabled.
4. Existing native staged-v2 ABI/source-layout contract tests after the Rust
   routing change.
5. Runtime CPU-reference parity and `single` versus `double` checks when an
   actual CUDA device is available; a host without CUDA cannot establish this
   numerical proof and must report the skip explicitly.
6. `git diff --check` for touched files.

## Deferred Work

- Adaptive staged-v2 `RK23` acceptance/rejection and FSAL.
- Staged-v2 `RK45` and `ABM3`.
- Thermal, Oersted, and spin-torque native multilayer RHS coverage.
- Hardware-optimized/interpolating `pull_h`.
- Remaining CPU FDM end-to-end SoA and production FFT backend completion from
  the broader backend audit.
