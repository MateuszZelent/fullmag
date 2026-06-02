---
name: capability-matrix-check
description: "Use when changing Fullmag backend legality, execution modes, planner resolution, capability vocabulary, or UI/runtime capability exposure across OpenAPI and the unified workspace."
---

# Fullmag Capability Matrix Check

## Preconditions

- The relevant `docs/physics/` note exists.
- Python DSL, `ProblemIR`, planner, runtime, provenance, OpenAPI, and UI implications are understood.
- The change is framed as a physical capability first, not a backend switch hidden in UI state.

## Required Checks

1. Classify legality for `strict`, `extended`, and future `hybrid`.
2. Classify requested execution choices: discretization (`fdm`, `fem`, `auto`), device (`cpu`, `gpu`, `auto`), precision (`single`, `double`), execution mode, and UI mode.
3. State what the planner may resolve automatically and what must remain visible as requested user intent.
4. State failure, degradation, and diagnostic behavior for unsupported paths. Hidden fallback is not allowed.
5. Keep Python DSL and UI authoring vocabulary aligned with `ProblemIR`; do not expose CUDA image names, MFEM internals, raw buffers, or implementation-only toggles as common semantics.
6. For FEM/MFEM, distinguish executable availability from validated workload coverage. `production_executable` on a FEM lane does not imply `validated` unless the operator-specific gates in `docs/physics/0900-native-fem-operator-contracts-and-validation.md` and the backend golden masterplan validation gates are covered.
7. For FEM/MFEM, record whether the affected feature belongs to exchange, a named demag strategy, local interactions, direct torques, thermal, stepper, runtime/residency, or observables so planner and UI status do not collapse the solver into one opaque FEM bucket.
8. Update capability maps so the unified workspace can guard commands, panels, and viewport layers without branching into separate FDM/FEM app trees.
9. Ensure OpenAPI schemas, generated frontend types, API modules, and resource hooks expose the capability vocabulary consistently.
10. Ensure session/run/provenance surfaces preserve requested intent, resolved backend/runtime, precision, degraded mode, and stage stop reasons where relevant.
11. Add tests covering planner capability decisions, OpenAPI/type generation impact, UI command gating, and unavailable-path diagnostics.

## Outputs

- Update `docs/specs/capability-matrix-v0.md`.
- Update OpenAPI source/specs and generated frontend types when capability vocabulary appears in browser contracts.
- Update `docs/specs/resource-first-control-room-api-v1.md` only when resource semantics change; OpenAPI is the executable browser contract.
- Record explicit go/no-go status for FDM, FEM, CPU, GPU, and hybrid where relevant
- Record fallback and diagnostic behavior for unavailable execution paths
- Update domain adapters, command registry/ribbon gating, and unified viewport capabilities when the browser can see or act on the capability.
- For backend solver ownership, source layout, runtime selection, workflow ownership, FEM demag model family, or production validation changes, update `docs/architecture/backend-golden-masterplan.md`.
- For FEM/MFEM implementation status changes, update or supersede historical `native-fem-*` docs only when they remain useful migration inputs; the accepted target architecture is the backend golden masterplan.
