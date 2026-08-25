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
