# Workflow: review-physics-completeness

## Purpose

Review whether a physics-facing feature is complete enough to merge.

## Review protocol

1. Does the corresponding `docs/physics/` note exist?
2. Are equations, symbols, SI units, and assumptions complete?
3. Are Python API, UI authoring/script export, `ProblemIR`, planner, and capability updates aligned?
4. Are requested and resolved execution implications explicit where runtime policy changed?
5. Are FDM, FEM, CPU, GPU, and hybrid differences explicit where relevant?
6. Are validation status, observables, tolerances, and deferred work recorded?

## Verdict

- `GO` - ready to merge
- `BLOCK` - documentation or validation is incomplete
