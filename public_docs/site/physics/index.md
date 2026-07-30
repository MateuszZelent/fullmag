---
title: Physics reference
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0000-physics-documentation-standard.md
---

(public-docs-physics-root)=
# Physics reference

Each public physics page follows the same chain:

physical problem → continuous equations → FDM and FEM interpretations → implementation → test →
reproducible example.

```{toctree}
:maxdepth: 3

foundations/index
interactions/index
```

```{toctree}
:hidden:

conventions
geometry-and-materials
exchange-demag-zeeman
```

## Publication rule

A public physics page must state equations, symbols, SI units, assumptions, backend
interpretations, API and ProblemIR impact, validation strategy, known limits and deferred work.
Source code or a synthetic oracle alone is not enough to call a backend qualified.

Each physical interaction has one canonical scientific owner. FDM, FEM, CPU, and GPU
realizations are separated inside that interaction documentation whenever their implementation,
support, or qualification differs.
