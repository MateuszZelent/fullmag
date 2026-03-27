---
name: problem-ir-design
description: "Use when introducing or changing Fullmag ProblemIR semantics after physics documentation has been prepared."
---

# ProblemIR design skill

## Preconditions

- The relevant `docs/physics/` note already exists and is complete.

## Outputs

1. Proposed changes to typed IR sections in `crates/fullmag-ir/`
2. Rust-side validation rules for Python-authored and UI-authored IR
3. Planner, capability, and runtime-selection implications
4. Serialization and normalization notes
5. Required Python API mappings in `packages/fullmag-py/` and any UI round-trip or script-export constraints
6. IR compatibility or migration notes if the change is breaking

## Core rules

- Python and UI authoring must converge to canonical IR.
- Rust validates, normalizes, and plans canonical IR.
- The shared IR must not contain grid internals, raw GPU details, or FEM-only implementation detail.
- Backend or device specificity belongs in explicit hint or runtime-policy surfaces, not as ambient
  leakage into shared semantics.
