---
name: problem-ir-design
description: "Use when introducing or changing Fullmag ProblemIR semantics after physics documentation, including Python/UI round-trip, planner capability, runtime provenance, OpenAPI exposure, and unified workspace implications."
---

# Fullmag ProblemIR Design

Use this skill after the relevant physics documentation exists and public authoring intent is understood. The user instruction and root `AGENTS.md` take precedence. Reuse `physics-publication` and other skills already loaded in the current turn.

## Preconditions

- A relevant `docs/physics/` note exists and is complete, or the change is policy-only and cites its existing note.
- Public authoring intent is understood before backend storage or UI state is designed.
- The affected IR, planner, runtime, API, and UI layers are identified.

## Required outputs

Produce only the outputs for affected layers:

- typed IR changes in `crates/fullmag-ir/`;
- validation and normalization for Python-authored and UI-authored IR;
- Python DSL mapping and canonical script export constraints;
- planner, capability, execution-selection, runtime-stage, and provenance implications;
- serialization, migration, and compatibility notes for breaking changes;
- OpenAPI/resource consequences when domain, mesh, fields, scalars, stages, commands, artifacts, diagnostics, or display selection change;
- resource hooks, ribbon commands, inspectors, docks, viewport layers, and adapter implications when browser behavior changes;
- focused tests for the changed round-trip, planner, API, or adapter contracts.

## Core rules

- Python and UI authoring converge to canonical IR.
- Rust validates, normalizes, and plans canonical IR.
- Shared IR describes physical micromagnetic intent, not grid internals, raw GPU buffers, OpenAPI transport shapes, or FEM-only implementation detail.
- Backend/device specificity belongs in explicit execution intent, advanced hints, or resolved runtime/provenance surfaces.
- `auto` may be resolved, but requested intent must survive planning and provenance.
- IR changes must not force direct React `fetch()`, backend-specific wire shapes, or duplicated FDM/FEM UI trees.
- For FEM, preserve universe mesh config, per-object mesh config, and final shared-domain solver mesh as distinct semantics.
- For stages, preserve explicit lifecycle and stop reasons; relaxation is not merely a run with a different stop criterion.
