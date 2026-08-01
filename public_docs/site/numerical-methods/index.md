---
title: Numerical Methods
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-root)=
# Numerical Methods

This page reserves the public documentation location for the numerical-methods documentation family.

Numerical methods in Fullmag are documented as realizations of one canonical physical
problem. The page hierarchy separates the method family, the discretization (FDM or FEM),
and the execution lane (CPU or GPU) without duplicating the physical model four times.
Each terminal page records equations, units, public Python parameters, `ProblemIR`, source
symbols, validation evidence, and qualification limits.

## How to read this section

The method pages answer five different questions:

1. what continuous or semi-discrete problem is solved;
2. how FDM and FEM represent it;
3. how CPU and GPU lanes differ in memory ownership, precision, and solver policy;
4. which public parameters reach the canonical IR;
5. which statements are source-backed and which remain unqualified.

The first executable examples use `fm.study(...)` and ordered
`study.stages.add_*` calls. They are user workflows, not internal object-construction
or serialization snippets.

```{toctree}
:maxdepth: 1

time-integration/index
relaxation/index
demag-solvers/index
eigensolvers/index
frequency-domain/index
meshing/index
interpolation-and-state-transfer/index
```
