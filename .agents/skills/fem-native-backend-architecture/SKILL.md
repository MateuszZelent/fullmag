---
name: fem-native-backend-architecture
description: "Use when modifying or reviewing the current native FEM/MFEM backend architecture, Context ownership, mfem_bridge.cpp, FEM CPU/GPU separation, FEM operator extraction, FEM demag strategy families, exchange, local interactions, workflows, integrators, or FEM solver performance."
---

# FEM/MFEM Backend Architecture

Use this skill for architecture, documentation, operator extraction, interactions, workflows, integrators, runtime ownership, or performance work in the current `backends/fem` MFEM/hypre/libCEED tree. `native/backends/fem` is the previous path from the controlled relocation, not the current production owner.

The user instruction and root `AGENTS.md` take precedence. Use `../../instructions/backend.md` as shared routing when present. Reuse already loaded skills; do not read the same skill twice in one turn.

## Build and runtime boundary

Inspect the repository `justfile` before native FEM work. Use the matching container-backed managed recipe first for build and runtime proof. Host `cargo`, `cmake`, Docker, and direct binaries are smoke diagnostics only unless a host-only check is explicitly requested. If no matching managed recipe exists, state that before using a host diagnostic. Do not start with a hand-built host command when a managed recipe covers the work.

## Read first

Read the backend golden masterplan, the affected `docs/physics/` note, and the affected capability entry. Read historical native-FEM docs only when migration context is needed.

## Required architecture checks

- identify FDM CPU, FDM GPU, FEM CPU, or FEM GPU;
- keep one backend-neutral contract for signs, units, fields, torques, energies, and observables;
- keep FEM production under MFEM/hypre/libCEED and current `backends/fem`;
- add no new physics directly to `mfem_bridge.cpp` and no undocumented cross-cutting state to `Context`;
- give problem config, mesh/regions, materials, fields, interactions, workflows, demag strategies, device runtime, and diagnostics explicit owners;
- keep FEM CPU independent from mandatory GPU residency;
- keep these demag strategies distinct: `poisson_airbox_dirichlet`, `poisson_airbox_robin`, `poisson_airbox_pbc_reduced`, `fem_bem_fredkin_koehler`, future `bem`, `fmm`, and `mapped_exterior_shell`;
- keep model selection, mesh requirements, boundary variant, solver policy, runtime realization, provenance, and validation separate;
- fail clearly for strict FEM GPU when device-resident prerequisites are missing; never silently use `hybrid_cpu_poisson`;
- keep numerical workflow ownership in `backends/fem`; runner code only orchestrates native calls, ABI, artifacts, and provenance;
- avoid hot-path heap allocation and hidden host/device transfers when the changed path is an accepted-step operator/RHS;
- distinguish `production_executable` from `validated`.

For a changed interaction or numerical operator, preserve the applicable directional derivative, analytical demag, convergence, unit/sign, capability-reject, phase-telemetry, and performance gates. Do not run unrelated gates for docs-only or unaffected subsystems.

## Documentation and blocker policy

Update the backend masterplan when ownership, source layout, runtime selection, demag family, or validation policy changes. Update capability docs when legality, execution status, fallback, or validation coverage changes. For physics changes, document energy/torque, SI units, weak form, boundaries, capabilities, telemetry, and validation.

Do not call a change production-ready when it lacks an energy/field/torque contract, accepts `fe_order > 1` without a real implementation, hides demag model/mesh/residual provenance, lacks required STT/DMI/thermal validation, depends on hidden GPU state, or makes `Context`/bridge files more central.
