# ADR 0014 - Native FEM Backend Modularization

**Status:** proposed
**Date:** 2026-05-16
**Decision makers:** core team

## Context

The 2026-05-16 FEM CPU audit found that the public Fullmag architecture is
directionally sound, but the native FEM backend is still too monolithic. The
main risk is not MFEM itself. The risk is that `Context` and `mfem_bridge.cpp`
currently combine runtime selection, FE spaces, materials, field buffers,
exchange, demag, DMI, local terms, thermal noise, STT, RK stepping, telemetry,
and CPU/GPU residency in the same implementation region.

That shape makes the solver hard to audit, hard to profile, and unsafe to
extend. It also encourages CPU and GPU paths to carry separate copies of the
same physics instead of implementing one backend-neutral contract.

Relevant audit package:

- `docs/reports/16.05.2026/fullmag_fem_cpu_audit.md`
- `docs/reports/16.05.2026/fullmag_fem_cpu_refactor_architecture.md`
- `docs/reports/16.05.2026/fullmag_fem_cpu_refactor_plan.md`
- `docs/reports/16.05.2026/fullmag_fem_cpu_implementation_instructions.md`
- `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

## Decision

Adopt a modular native FEM backend architecture with these stable boundaries:

1. Backend-neutral physics contracts remain above CPU/GPU implementation.
2. FEM core owns state, interaction registry, telemetry, and lifecycle
   contracts without depending on MFEM, CUDA, hypre, or libCEED specifics.
3. CPU/MFEM and GPU/CUDA are backend realizations of the same FEM contracts,
   not separate physics engines.
4. Every interaction or solver family has a dedicated module boundary:
   exchange, demag, Zeeman, uniaxial anisotropy, cubic anisotropy, DMI,
   thermal, STT, Oersted, magnetoelastic, and explicit steppers.
5. Demag is a first-class subsystem with separate setup, RHS assembly, linear
   solve, field recovery, energy, boundary policy, telemetry, and validation.
6. `Context` becomes a narrow ownership facade over explicit subsystems rather
   than the place where new physics or runtime state accumulates.
7. `mfem_bridge.cpp` must shrink toward a compatibility/adapter layer; it must
   not remain the strategic center for physics, solvers, and runtime.

The canonical target specification is:

- `docs/specs/native-fem-backend-architecture-v1.md`

The canonical numerics and validation standard is:

- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`

## Consequences

Positive:

- Operator-level tests can validate energy, field, torque, units, boundary
  conditions, and telemetry independently.
- CPU and GPU can be compared against one contract instead of drifting through
  copied formulas.
- Demag Poisson optimization can target the real bottleneck without pulling in
  unrelated integrator, DMI, or device-residency concerns.
- Capability status can distinguish executable implementation from validated
  production qualification.
- Future FEM BEM/FMM/Fredkin-Koehler demag strategies have a clear insertion
  point behind the same `DemagSubsystem` contract.

Trade-offs:

- Refactoring must proceed in small strangler steps, not as a big-bang folder
  move.
- Existing source-level tests may temporarily need to guard compatibility code
  until modules are fully extracted.
- Some executable features must remain explicitly unvalidated until their
  operator-specific gates exist.

## Implementation Obligations

- Do not add new interaction physics directly to `mfem_bridge.cpp`.
- Do not add new cross-cutting ownership state directly to `Context` unless it
  is part of a transitional move with a documented removal step.
- New FEM interactions require a `docs/physics/` note covering energy or
  torque, SI units, boundary conditions, FEM discretization, capability, and
  validation.
- Native FEM CPU work must not require live GPU residency state unless the mode
  is explicitly an interop path.
- Native FEM GPU work must implement the same physics contract as CPU; device
  kernels may differ, signs and units may not.
- Capability matrix entries must not use `validated` unless the documented
  validation matrix has explicit passing workloads for that feature and lane.
- Performance work must preserve phase telemetry and use no hot-path heap
  allocation for accepted-step RHS/operator application.
- Solver rebuilds must preserve the opt-in session profiler, including the
  `set_solver_profile` command, `diagnostics/solver-profile` resource, stable
  phase IDs, bounded ring buffer, and disabled-by-default/no-allocation
  behavior.

## Migration Plan

Use a strangler migration:

1. Freeze operator/state contracts in docs and tests.
2. Split `Context` into explicit state and subsystem owners.
3. Extract simple local terms first where the numerical risk is low.
4. Extract exchange and mass/projection operators.
5. Extract demag as its own Poisson subsystem.
6. Extract DMI, thermal, STT, Oersted, and magnetoelastic with their validation
   gates.
7. Move remaining MFEM bridge code into runtime, spaces, operators,
   interactions, solvers, integrators, and observables modules.

Folder moves without contract extraction do not satisfy this ADR.

## Validation

Completion requires:

- source and runtime tests that prove CPU availability is independent of GPU
  availability;
- operator-level variational tests for energy-derived fields;
- analytical demag tests for sphere, ellipsoid/prism, and airbox convergence;
- explicit LLG and gamma convention tests;
- per-feature capability reject tests for unsupported FEM order, unsupported
  boundary modes, and unqualified physics;
- performance benchmarks with phase timing for demag RHS, solve, recovery,
  energy, and total step time.

## Rollback

Before the modular backend becomes default, rollback is to continue using the
existing native FEM compatibility path. Rollback must not delete the new
contracts or reclassify unvalidated features as validated.
