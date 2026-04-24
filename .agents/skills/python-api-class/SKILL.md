---
name: python-api-class
description: "Use when adding or modifying a public class or exported construct in the Fullmag Python DSL, ensuring canonical script export, ProblemIR lowering, validation, planner/runtime semantics, and UI round-trip stay aligned."
---

# Fullmag Python API Class

## Goal

Keep the public authoring chain coherent:

`docs/physics -> Python DSL -> ProblemIR -> planner/capability/runtime/provenance -> OpenAPI/resources -> UI script export`

## Preconditions

- The relevant `docs/physics/` note exists.
- The corresponding `ProblemIR` change is designed.
- The class represents public physical intent, not a private backend or viewport convenience.

## Checklist

1. Add or update the public class in `packages/fullmag-py/src/fullmag/`.
2. Use SI-clean names, defaults, validation, and type hints. Avoid backend names in common parameters.
3. Provide `to_ir()` or the local canonical serialization path.
4. Preserve human-editable script export and UI round-trip stability.
5. Export the construct from the public `fullmag` namespace only when it is ready as a public contract.
6. Keep execution selection explicit: requested discretization/device/precision/mode must not disappear into defaults.
7. Record OpenAPI/UI impact when the class changes scene documents, script builder output, resource payloads, stages, commands, or display selection.
8. Add tests for construction, validation errors, serialization, Python -> IR, UI/script export round-trip, and migration behavior where relevant.
9. Add or update examples only when they teach canonical public usage, not transitional internals.

## Naming rules

- Classes: PascalCase
- Parameters: snake_case
- Public names should map cleanly onto IR terms, physics notes, and UI vocabulary
- Backend-specific knobs belong in explicit advanced/backend-hint scopes
