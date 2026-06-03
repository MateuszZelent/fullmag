---
name: fem-native-backend-architecture
description: "Use when modifying or reviewing the current native FEM/MFEM backend architecture, Context ownership, mfem_bridge.cpp, FEM CPU/GPU separation, FEM operator extraction, FEM demag strategy families, exchange, local interactions, workflows, integrators, or FEM solver performance."
---

# FEM/MFEM Backend Architecture

Use this skill for any work touching FEM solver architecture or documentation.
This skill covers the current `backends/fem` MFEM/hypre/libCEED implementation
tree. The previous `native/backends/fem` path was production code, not legacy;
it has been relocated to top-level `backends/fem`, not moved into `crates`.

## Read First

1. `docs/architecture/backend-golden-masterplan.md`
2. Relevant interaction or workflow note in `docs/physics/`
3. Relevant capability entry in `docs/specs/capability-matrix-v0.md`
4. Historical native-FEM docs only for context when needed; the backend golden
   masterplan wins on target ownership:
   - `docs/adr/0014-native-fem-backend-modularization.md`
   - `docs/specs/native-fem-backend-architecture-v1.md`
   - `docs/physics/0900-native-fem-operator-contracts-and-validation.md`

## Required Checks

1. Identify the solver lane before editing: FDM CPU, FDM GPU, FEM CPU, or FEM
   GPU.
2. Keep one backend-neutral physics contract. CPU/GPU/FDM/FEM may implement
   different numerics, but signs, units, fields, torques, and observables must
   not drift.
3. Do not build or extend a standalone in-house FEM numerical stack beside
   MFEM/hypre/libCEED. FEM production work means MFEM/hypre/libCEED CPU/GPU
   integration under current `backends/fem`.
4. Do not add new physics directly to `mfem_bridge.cpp`. New interactions need
   a dedicated module boundary, validation plan, telemetry, and capability
   status.
5. Do not add new cross-cutting ownership state directly to `Context` unless it
   is a documented transitional field with a target subsystem and removal
   condition.
6. Split responsibilities into explicit owners: problem config, mesh/regions,
   materials, field buffers, interaction modules, workflow modules, demag
   strategy subsystems, device runtime, and diagnostics.
7. Keep FEM CPU independent from mandatory GPU residency. GPU state may
   be used only through an explicit GPU or interop path.
8. Treat FEM demag as a model family, not a single Poisson module:
   - `poisson_airbox_dirichlet`
   - `poisson_airbox_robin`
   - `poisson_airbox_pbc_reduced`
   - `fem_bem_fredkin_koehler`
   - future `bem`, `fmm`, and `mapped_exterior_shell`
9. For FEM demag, keep model selection, mesh requirements, boundary variant,
   solver policy, runtime realization, provenance, and validation separate.
   Body-only FEM/BEM/FMM paths must not allocate or require volumetric airbox.
10. Strict FEM GPU requests must fail clearly if device-resident prerequisites
   are missing. Do not silently fallback to `hybrid_cpu_poisson`.
11. Workflow algorithms must live in explicit owners. Production FEM numerical
   workflow behavior belongs under current `backends/fem`; Rust runner
   workflow code may orchestrate native calls but must not duplicate
   MFEM/hypre/libCEED implementation. Do not bury new
   ownership in `execute.rs`, `dispatch.rs`, `Context`, or bridge files.
12. Distinguish executable status from validated status in capability docs and
   provenance. `production_executable` is not the same as `validated`.
13. Preserve or add validation: directional derivative for energy-derived
   fields, analytical demag checks, cross-model FEM demag convergence,
   unit/sign tests, capability reject tests, and performance gates with phase
   timings.
14. Avoid hot-path heap allocation and hidden host/device transfers in accepted
   step RHS/operator application.

## Documentation Outputs

For architecture changes:

- update `docs/architecture/backend-golden-masterplan.md` when solver lane,
  source ownership, workflow ownership, demag strategy ownership, or production
  validation policy changes;
- update or supersede historical `native-fem-*` docs only when they remain
  linked by the affected subsystem;
- update `docs/specs/capability-matrix-v0.md` when legality, execution status,
  fallback, or validation coverage changes.

For physics or numerics changes:

- update or create the relevant `docs/physics/` note;
- record energy or torque, SI units, FEM weak form, boundary conditions,
  capability restrictions, observables, telemetry, and validation tests.

## Blocker Policy

Do not present a FEM/MFEM solver change as production-ready when:

- the interaction lacks an energy/field/torque contract;
- `fe_order > 1` is accepted without a real high-order implementation;
- demag lacks requested/resolved model, mesh requirements, residual/iteration
  telemetry where applicable, phase telemetry, and model-family validation;
- STT/DMI/thermal are executable but lack their required validation gates;
- CPU execution depends on hidden GPU state;
- the change makes `Context` or `mfem_bridge.cpp` more central.
