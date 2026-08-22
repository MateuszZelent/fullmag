---
title: Airbox Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-airbox-root)=
# Airbox mesh

The airbox is the nonmagnetic exterior domain used by FEM scalar-potential magnetostatics and related
operators. It is generated and refined independently from magnetic bodies, then joined to them in
the shared domain.

```{toctree}
:maxdepth: 2

geometry
grading
boundary-conditions
```

Airbox extent, closure, and mesh resolution are independent numerical-error sources. Refining the
magnetic body alone cannot establish open-boundary convergence.
