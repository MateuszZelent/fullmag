---
title: Eigensolvers
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-eigensolvers-root)=
# Eigensolvers

The eigensolver family linearizes the Landau–Lifshitz–Gilbert dynamics around a declared
equilibrium, constructs a tangent-space dynamic operator, and returns complex eigenvalues and mode
fields. The public study stage is documented in {doc}`linearized-llg`; validation and qualification
are documented in {doc}`modal-validation`. FEM is the current native modal lane; a Python request is
not a claim that every FDM or GPU combination is executable.

The hierarchy is intentional: the physical linearization is one owner, while target selection,
normalization, damping policy, Bloch sampling and validation are separate subsections. Solver
device and precision remain resolved execution attributes rather than duplicate physics pages.

```{toctree}
:maxdepth: 1

linearized-llg
modal-validation
```
