---
name: python-api-class
description: "Use when adding or modifying a public class in the fullmag embedded Python DSL."
---

# Python API class skill

## Goal

Keep the chain coherent:

`docs/physics -> fullmag Python API and UI export shapes -> ProblemIR -> planner/capability/session`

## Preconditions

- The relevant `docs/physics/` note exists.
- The corresponding `ProblemIR` change is designed.

## Checklist

1. Add or update the public class in `packages/fullmag-py/src/fullmag/`
2. Validate parameters and preserve type hints
3. Provide `to_ir()` or equivalent canonical serialization
4. Keep the class shape stable for canonical script export and UI round-trip use when relevant
5. Export the class from the public `fullmag` namespace
6. Add or update tests, including serialization or round-trip coverage when the public surface changes
7. Add or update an example when the public surface changes

## Naming rules

- Classes: PascalCase
- Parameters: snake_case
- Public names should map cleanly onto IR terms, physics notes, and UI vocabulary
