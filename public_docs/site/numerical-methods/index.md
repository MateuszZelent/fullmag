---
title: Numerical Methods
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-root)=
# Numerical Methods

This family documents algorithms that operate on an already defined spatial discretization:
time integration, relaxation, demagnetization solves, eigensolvers, frequency-domain response, and
state transfer.

Meshing is intentionally owned by the Backend branch at {doc}`meshing/index`, because geometry
realization, topology, airbox construction, and quality governance form an independent subsystem.

```{toctree}
:maxdepth: 2

time-integration/index
relaxation/index
demag-solvers/index
eigensolvers/index
frequency-domain/index
interpolation-and-state-transfer/index
```
## Control Room crosswalk

This is a navigation page; use the terminal page named by the selected stage or solver. The category itself has no standalone editor. TODO: frontend support applies to numerical parameters without a matching control. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
