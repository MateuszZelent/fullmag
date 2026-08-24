---
title: FEM Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-root)=
# FEM Meshing

FEM meshing builds one conforming solver domain from magnetic bodies, object-owned regions, optional
air, boundaries, periodic pairs, and local size/topology policies.

The branch is split into three owners:

1. **Shared domain** — assembly, conformity, attributes, selectors, and fallback.
2. **Ferromagnet mesh** — tetrahedral, thin-film, swept, boundary-layer, imported, and mixed modes.
3. **Airbox mesh** — exterior geometry, grading, closure markers, and periodic variants.

```{toctree}
:maxdepth: 3

shared-domain/index
ferromagnet/index
airbox/index
```
