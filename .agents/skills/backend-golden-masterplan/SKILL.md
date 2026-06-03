---
name: backend-golden-masterplan
description: "Use when modifying or reviewing Fullmag backend solver architecture, source layout, runtime selection, FDM/FEM CPU/GPU lane ownership, interaction modules, workflows, production physics validation, or backend documentation."
---

# Backend Golden Masterplan

Use this skill before backend architecture, solver layout, runtime selection,
interaction, workflow, validation, or backend documentation changes.

## Read First

1. `docs/architecture/backend-golden-masterplan.md`
2. Relevant `docs/physics/` note for the interaction, workflow, or validation
   target.
3. Relevant `docs/specs/capability-matrix-v0.md` entry when legality,
   execution status, fallback, or validation status changes.
4. Relevant API/resource docs when backend behavior is visible in sessions,
   generated OpenAPI, `ControlRoomApi`, resources, or control-room views.

## Required Checks

1. Identify the solver lane before editing:
   - FDM CPU
   - FDM GPU
   - FEM CPU
   - FEM GPU
2. Keep FDM and FEM implementations separate. Cross-discretization movement is
   state transfer with provenance and validation, not a hidden solver call.
3. Keep CPU and GPU as separate realizations of the same backend-neutral
   physics contract. Do not duplicate signs, units, energy conventions, field
   semantics, or observable IDs per device.
4. Do not add solver logic to `crates/fullmag-runner/src/dispatch.rs`.
   Compatibility routing there must name its target owner.
5. Do not add new physics or workflow algorithms to `Context`,
   `mfem_bridge.cpp`, generic `execute.rs`, or generic `mod.rs` files.
6. Every interaction must own parameters, field or weak form, energy,
   energy-density/observables, validation fixtures, and CPU/GPU realization
   adapters where implemented.
7. Every workflow must have a discoverable owner. Production native numerical
   workflow behavior belongs under current top-level `backends/*`; Rust runner
   workflow code is orchestration, ABI, artifacts, preview, and provenance only.
8. FEM production means MFEM/hypre/libCEED CPU/GPU integration. Do not grow a
   standalone in-house FEM numerical stack beside it, and do not move
   production FEM ownership into `crates`. `backends/fem` is the current tree
   after the controlled relocation from `native/backends/fem`.
9. FEM demag is a strategy family. Keep `poisson_airbox`,
   `pbc_reduced_poisson`, `fem_bem`, `fmm`, and `mapped_exterior_shell`
   separated by mesh requirements, boundary semantics, runtime realization,
   provenance, and validation.
10. Forced GPU requests must fail clearly when prerequisites are missing.
    Silent CPU fallback is allowed only for documented non-forced modes and
    must be visible in provenance.
11. Runtime proof is separate from local contract proof. Do not claim CUDA,
    MFEM, hypre, or libCEED runtime behavior from unit tests alone.
12. Production physics claims require automated validation: NIST/µMAG where
    applicable, analytical benchmarks, per-interaction energies, total energy,
    CPU/GPU parity inside a discretization, and meaningful FDM/FEM convergence
    comparisons.

## Documentation Outputs

Update `docs/architecture/backend-golden-masterplan.md` when changing:

- solver lane ownership;
- source layout;
- runtime selection or fallback policy;
- interaction/workflow ownership;
- FEM demag strategy ownership;
- production physics validation policy.

Update lower-level docs only after checking they do not contradict the
masterplan. Historical `native-fem-*` docs are context only when they conflict;
accepted target docs and agent instructions should say that `backends/fem` is
the current MFEM/hypre/libCEED implementation tree, and `native/backends/fem`
is only the previous path from the controlled relocation.

## Blocker Policy

Block or revise the change if it:

- adds a new monolith or grows an existing one;
- hides fallback or device migration;
- makes FDM/FEM or CPU/GPU behavior diverge without a backend-neutral contract;
- treats executable status as validated physics;
- adds public backend semantics without API/resource/OpenAPI/client impact
  review;
- adds or changes physics without units, observables, tolerances, and
  validation targets.
