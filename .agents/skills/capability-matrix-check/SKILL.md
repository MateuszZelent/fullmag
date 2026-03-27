---
name: capability-matrix-check
description: "Use when changing backend legality, execution modes, or capability coverage in Fullmag."
---

# Capability matrix check skill

## Preconditions

- The relevant `docs/physics/` note exists.
- `ProblemIR`, Python API, and UI authoring implications are already understood.

## Checklist

1. Is the feature legal in `strict`?
2. What is only legal in `extended`, and why?
3. What does hybrid execution require?
4. Which requested execution choices (`fdm` / `fem` / `cpu` / `gpu` / `auto` / precision) are legal?
5. What may the planner resolve automatically, and what must stay explicit to the user?
6. Do the Python API and UI expose the feature without leaking backend internals?
7. Do session/run/provenance views distinguish requested vs resolved execution clearly enough?
8. What tests or smoke checks are required?

## Outputs

- Update `docs/specs/capability-matrix-v0.md`
- Record explicit go/no-go status for FDM, FEM, CPU, GPU, and hybrid where relevant
- Record fallback and diagnostic behavior for unavailable execution paths
