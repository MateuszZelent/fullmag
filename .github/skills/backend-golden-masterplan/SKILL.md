---
name: backend-golden-masterplan
description: "Use when modifying or reviewing Fullmag backend solver architecture, source layout, runtime selection, FDM/FEM CPU/GPU lane ownership, interaction modules, workflows, production physics validation, or backend documentation."
---

# Backend Golden Masterplan

Use this skill for backend architecture, solver layout, runtime selection, interactions, workflows, production validation, or backend documentation.

The user instruction and root `AGENTS.md` take precedence. If `../../instructions/backend.md` exists, use it as the shared routing source. Reuse any skill already loaded in the current turn; do not read it again unless it changed or a referenced source is missing.

## Build and runtime boundary

For FEM/MFEM/CUDA/hypre/libCEED work, inspect the repository `justfile` first and use the matching managed/container recipe as the default build and runtime path. Host `cargo`, `cmake`, Docker, or direct native binaries are diagnostics only unless the user explicitly requests a host-only check. If no matching managed recipe exists, record that fact before using a host diagnostic. Do not start with a hand-built host FEM command when a managed recipe owns the task.

## Read the smallest relevant set

Read:

1. `docs/architecture/backend-golden-masterplan.md`;
2. the relevant `docs/physics/` note;
3. the relevant capability entry in `docs/specs/capability-matrix-v0.md` when legality, fallback, execution status, or validation status changes;
4. affected API/resource documentation only when backend behavior is browser-visible.

## Required checks

Apply checks that match the affected lane and layer:

- identify FDM CPU, FDM GPU, FEM CPU, or FEM GPU;
- keep FDM/FEM and CPU/GPU as realizations of one backend-neutral physics contract;
- keep cross-discretization movement explicit state transfer with provenance and validation;
- keep runner dispatch, `Context`, `mfem_bridge.cpp`, generic `execute.rs`, and generic `mod.rs` files out of new solver ownership;
- give each interaction an owner for parameters, field or weak form, energy, observables, validation fixtures, and implemented CPU/GPU adapters;
- give each workflow a discoverable owner; runner code orchestrates ABI, artifacts, preview, and provenance;
- keep production FEM under `backends/fem` with MFEM/hypre/libCEED, not a parallel in-house FEM stack;
- keep FEM demag strategies separate by mesh requirements, boundaries, realization, provenance, and validation;
- make forced GPU failure explicit and visible; permit fallback only for documented non-forced modes;
- distinguish executable availability, source/contract checks, runtime evidence, and validated physics.

For a production physics or runtime claim, require the applicable analytical/NIST/µMAG checks, per-interaction and total energies, within-lane CPU/GPU parity, and meaningful convergence evidence. Do not require unrelated lanes for a docs-only or isolated orchestration change.

## Documentation outputs

Update `docs/architecture/backend-golden-masterplan.md` only when ownership, source layout, runtime selection, fallback policy, interaction/workflow ownership, FEM demag strategy, or validation policy changes. Update lower-level docs only when the affected contract changes. Historical `native/backends/fem` material is context; the current production tree is `backends/fem`.

## Blockers

Stop a production claim when the change hides fallback or device migration, diverges from the backend-neutral contract, treats executable status as physics validation, adds public semantics without API/resource review, or omits units, observables, tolerances, and validation targets for changed physics.
