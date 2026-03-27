---
name: physics-publication
description: "Use when adding or modifying any Fullmag physics or numerics feature. Create or update a publication-style note in docs/physics before writing code."
---

# Physics publication skill

## Goal

Enforce the project rule: physics first, implementation second.

## When to trigger

- adding a new energy term, dynamics model, or numerical method,
- changing equations, assumptions, or units,
- changing backend interpretation, execution-selection semantics, or validation scope,
- changing shared problem semantics for physics-facing features.

## Required outputs

1. A `docs/physics/<topic>.md` note based on `docs/physics/TEMPLATE.md`
2. Governing equations, symbols, SI units, assumptions, and approximations
3. Explicit FDM, FEM, CPU, GPU, and hybrid interpretation where relevant
4. Python API, UI authoring, and script-export impact
5. `ProblemIR` impact
6. Planner, capability-matrix, and runtime-selection impact
7. Validation strategy, observables, tolerances, and provenance expectations
8. Completeness checklist and deferred work

## Blocker policy

If the note is missing or incomplete, implementation is blocked.

## Cascade

After this skill completes, run:

1. `problem-ir-design`
2. `python-api-class`
3. `capability-matrix-check`
