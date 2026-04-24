---
name: problem-ir-design
description: "Use when introducing or changing Fullmag ProblemIR semantics after physics documentation, including Python/UI round-trip, planner capability, runtime provenance, OpenAPI exposure, and unified workspace implications."
---

# Fullmag ProblemIR Design

## Preconditions

- The relevant `docs/physics/` note already exists and is complete.
- Public authoring intent is understood before backend storage or UI state is designed.

## Outputs

1. Proposed changes to typed IR sections in `crates/fullmag-ir/`.
2. Validation and normalization rules for Python-authored and UI-authored IR.
3. Python DSL mappings in `packages/fullmag-py/` and canonical script export constraints.
4. Planner, capability, execution-selection, runtime-stage, and provenance implications.
5. Serialization, migration, and compatibility notes for breaking changes.
6. OpenAPI/resource consequences if the IR affects domain, mesh, fields, scalars, stages, commands, artifacts, diagnostics, or display selection.
7. UI implications for resource hooks, domain adapters, ribbon commands, inspectors, docks, and unified viewport layers.
8. Required tests for Python -> IR, UI/script export -> IR, planner validation, API generated types, and viewport/domain adapter behavior where relevant.

## Core rules

- Python and UI authoring must converge to canonical IR.
- Rust validates, normalizes, and plans canonical IR.
- Shared IR describes physical micromagnetic intent, not grid internals, raw GPU buffers, OpenAPI transport shapes, or FEM-only implementation detail.
- Backend or device specificity belongs in explicit execution intent, advanced hints, or resolved runtime/provenance surfaces.
- `auto` choices may be resolved, but requested intent must survive planning and provenance.
- IR changes must not force direct React `fetch()`, backend-specific wire shapes, or duplicated FDM/FEM UI trees.
- For FEM, preserve universe mesh config, per-object mesh config, and final shared-domain solver mesh as distinct semantics.
- For stages, preserve explicit lifecycle and stop reasons. "Relax = run with a different stop" is not enough.
