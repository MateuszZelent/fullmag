---
title: Physics reference
status: draft
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0000-physics-documentation-standard.md
---

# Physics reference

Each public physics page follows the same chain:

physical problem → continuous equations → FDM and FEM interpretations → implementation → test →
reproducible example.

```{toctree}
:maxdepth: 2

conventions
geometry-and-materials
exchange
exchange-demag-zeeman
```

## Publication rule

A public physics page must state equations, symbols, SI units, assumptions, backend
interpretations, API and ProblemIR impact, validation strategy, known limits and deferred work.
Source code or a synthetic oracle alone is not enough to call a backend qualified.
