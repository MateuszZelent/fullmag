---
name: python-api-class
description: "Use when adding or modifying a public class or exported construct in the Fullmag Python DSL."
---

# Fullmag Python API Class

Use this skill for a public physical construct in `packages/fullmag-py/src/fullmag/`. The user instruction and root `AGENTS.md` take precedence. Reuse already loaded physics, IR, capability, and resource skills.

## Preconditions

- The relevant `docs/physics/` note exists or the change cites the existing semantic contract.
- The corresponding `ProblemIR` change is designed when IR semantics change.
- The class represents public physical intent, not a private backend or viewport convenience.

## Checklist

1. Add or update the public class with SI-clean names, defaults, validation, and type hints.
2. Provide `to_ir()` or the local canonical serialization path.
3. Preserve human-editable script export and UI round-trip stability.
4. Export from the public `fullmag` namespace only when ready as a public contract.
5. Keep requested discretization, device, precision, and mode explicit; do not erase intent into defaults.
6. Record OpenAPI/UI impact when the construct changes scene documents, script builder output, resource payloads, stages, commands, or display selection.
7. Add focused tests for construction, validation, serialization, Python → IR, script export, UI round-trip, or migration only where those surfaces changed.
8. Add examples only when they teach canonical public usage.

## Naming

- Classes: PascalCase.
- Parameters: snake_case.
- Public names map to IR terms, physics notes, and UI vocabulary.
- Backend-specific knobs belong in explicit advanced/backend-hint scopes.
