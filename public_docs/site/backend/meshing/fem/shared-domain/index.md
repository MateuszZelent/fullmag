---
title: FEM Shared Domain
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-shared-domain-root)=
# FEM shared domain

The shared domain is the conforming geometric and algebraic substrate assembled from all magnetic
objects and, when required, the nonmagnetic airbox.

```{toctree}
:maxdepth: 2

assembly
attributes-and-interfaces
periodic-pairs
```

Magnetization and scalar potential may use different finite-element spaces on the same geometric
mesh. Magnetic-region selection therefore remains explicit; air is not represented as an ordinary
magnet with a zero saturation magnetization unless a specific operator declares that model.
