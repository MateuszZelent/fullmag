# Workflow: review-physics-completeness

## Purpose

Review whether a physics-facing feature is complete enough to merge.

## Review protocol

1. Does the corresponding `docs/physics/` note exist?
2. Are equations, symbols, SI units, and assumptions complete?
3. Are Python API, UI authoring/script export, `ProblemIR`, planner, and capability updates aligned?
4. Are requested and resolved execution implications explicit where runtime policy changed?
5. If the feature changes live quantities or runtime resources, is the resource-first control-room
   API impact explicit?
6. Are FDM, FEM, CPU, GPU, and hybrid differences explicit where relevant?
7. Are validation status, observables, tolerances, and deferred work recorded?
8. If the change touches backend ownership, runtime selection, solver layout, or
   production validation, does it align with
   `docs/architecture/backend-golden-masterplan.md`?
9. If the change touches FEM demag, are model family, mesh requirements,
   boundary variant, runtime realization, provenance, and validation target
   explicit instead of treating demag as one Poisson implementation?

## Verdict

- `GO` - ready to merge
- `BLOCK` - documentation or validation is incomplete
