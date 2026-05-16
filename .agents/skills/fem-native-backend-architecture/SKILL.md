---
name: fem-native-backend-architecture
description: "Use when modifying or reviewing native FEM backend architecture, Context ownership, mfem_bridge.cpp, FEM CPU/GPU separation, FEM operator extraction, demag Poisson, exchange, local interactions, integrators, or FEM solver performance."
---

# Native FEM Backend Architecture

Use this skill for any work touching native FEM solver architecture or
documentation.

## Read First

1. `docs/adr/0014-native-fem-backend-modularization.md`
2. `docs/specs/native-fem-backend-architecture-v1.md`
3. `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
4. Relevant interaction note in `docs/physics/`
5. Relevant capability entry in `docs/specs/capability-matrix-v0.md`

## Required Checks

1. Keep one backend-neutral physics contract. CPU/GPU/FDM/FEM may implement
   different numerics, but signs, units, fields, torques, and observables must
   not drift.
2. Do not add new physics directly to `mfem_bridge.cpp`. New interactions need
   a dedicated module boundary, validation plan, telemetry, and capability
   status.
3. Do not add new cross-cutting ownership state directly to `Context` unless it
   is a documented transitional field with a target subsystem and removal
   condition.
4. Split responsibilities into explicit owners: problem config, mesh/regions,
   materials, field buffers, demag subsystem, stepper subsystem, device runtime,
   and diagnostics.
5. Keep native FEM CPU independent from mandatory GPU residency. GPU state may
   be used only through an explicit GPU or interop path.
6. Treat demag Poisson as its own subsystem: setup, RHS, solve, recover,
   energy, boundary policy, warm start, and telemetry must be separable.
7. Distinguish executable status from validated status in capability docs and
   provenance. `production_executable` is not the same as `validated`.
8. Preserve or add validation: directional derivative for energy-derived
   fields, analytical demag checks, unit/sign tests, capability reject tests,
   and performance gates with phase timings.
9. Avoid hot-path heap allocation and hidden host/device transfers in accepted
   step RHS/operator application.

## Documentation Outputs

For architecture changes:

- update `docs/specs/native-fem-backend-architecture-v1.md`;
- update `docs/adr/0014-native-fem-backend-modularization.md` only when the
  long-lived decision changes;
- update `docs/specs/capability-matrix-v0.md` when legality, execution status,
  fallback, or validation coverage changes.

For physics or numerics changes:

- update or create the relevant `docs/physics/` note;
- record energy or torque, SI units, FEM weak form, boundary conditions,
  capability restrictions, observables, telemetry, and validation tests.

## Blocker Policy

Do not present a native FEM solver change as production-ready when:

- the interaction lacks an energy/field/torque contract;
- `fe_order > 1` is accepted without a real high-order implementation;
- demag lacks residual, iteration, and phase telemetry;
- STT/DMI/thermal are executable but lack their required validation gates;
- CPU execution depends on hidden GPU state;
- the change makes `Context` or `mfem_bridge.cpp` more central.
