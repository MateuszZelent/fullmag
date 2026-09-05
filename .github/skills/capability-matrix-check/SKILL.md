---
name: capability-matrix-check
description: "Use when changing Fullmag backend legality, execution modes, planner resolution, capability vocabulary, or UI/runtime capability exposure across OpenAPI and the unified workspace."
---

# Fullmag Capability Matrix Check

Use this skill when a capability, legality rule, execution choice, planner result, provenance field, or browser capability gate changes. The user instruction and root `AGENTS.md` take precedence. Reuse skills already loaded in the current turn.

## Preconditions

- A relevant `docs/physics/` note exists or the change is explicitly policy-only and cites the existing note.
- The public authoring intent is understood before changing backend storage or UI state.
- The affected planner, runtime, API, and UI layers are identified.

## Required checks

Apply only the checks for layers touched by the change:

1. Classify legality for `strict`, `extended`, and future `hybrid` where applicable.
2. Classify requested discretization (`fdm`, `fem`, `auto`), device, precision, execution mode, and UI mode.
3. State what the planner may resolve automatically and preserve requested intent in provenance.
4. Specify failure, degradation, diagnostic, and fallback behavior; hidden fallback is forbidden.
5. Keep Python DSL, UI, and `ProblemIR` vocabulary aligned; keep implementation-only names out of common semantics.
6. Separate executable availability from validated workload coverage, especially for FEM/MFEM.
7. Record whether the feature is exchange, a named demag strategy, local interaction, direct torque, thermal, stepper, residency, or observable.
8. Keep capability maps, OpenAPI schemas, generated frontend types, API modules, resource hooks, command gates, and viewport adapters aligned when browser-visible.
9. Preserve requested intent, resolved backend/runtime, precision, degraded mode, fallback rejection, and stage stop reasons where relevant.

For FEM/MFEM/CUDA/hypre/libCEED status changes, inspect the `justfile` first and use the matching container-backed recipe as authoritative proof. Host commands are smoke diagnostics only and cannot establish capability status alone.

## Outputs

Update only affected artifacts:

- `docs/specs/capability-matrix-v0.md`;
- OpenAPI source and generated types when the browser contract changes;
- `docs/specs/resource-first-control-room-api-v1.md` only when v1 resource semantics are actually affected;
- backend golden masterplan for ownership/runtime/validation decisions;
- domain adapters, command registry/ribbon gates, unified viewport capabilities, and tests when the browser can act on the capability.

Required tests are proportional: planner decisions for planner changes, contract/type tests for API changes, command gating for UI changes, and unavailable-path diagnostics whenever a path can fail.
