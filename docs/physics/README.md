# Physics documentation

`docs/physics/` is the mandatory publication-style record of Fullmag's physical and numerical scope.

## Golden rule

Before implementing any new physics or numerics feature, create or update a note in this directory.

That note must describe:

- problem statement and motivation,
- governing equations, symbols, and SI units,
- assumptions and approximations,
- FDM, FEM, and hybrid interpretation,
- Python API and `ProblemIR` impact,
- planner and capability-matrix impact,
- validation strategy,
- completeness across the stack,
- deferred work.

## Why this exists

This directory is intended to evolve into:

- internal technical notes,
- reproducibility and validation records,
- publication supplements,
- the canonical physics reference for human contributors and coding agents.

## Naming convention

Recommended filenames:

- `0000-physics-documentation-standard.md`
- `0050-shared-problem-semantics-and-embedded-python-api.md`
- `0100-mesh-and-region-discretization.md`
- `0200-llg-exchange-reference-engine.md`
- `0300-demagnetization.md`

The numbering is semantic, not bureaucratic.
