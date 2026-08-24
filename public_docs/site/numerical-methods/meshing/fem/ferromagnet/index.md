---
title: FEM Ferromagnet Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-root)=
# FEM Ferromagnet Meshing

Ferromagnet meshing owns element topology inside magnetic bodies. The mode is selected per object
and then reconciled with shared-domain conformity.

The modules below separate every source-visible mode. Representability in Python is not equivalent
to production qualification in the active backend/device lane.

```{toctree}
:maxdepth: 2

free-tetrahedral
thin-film-tetrahedral
../../swept-meshes
swept-prism
swept-hex
boundary-layers
imported-mesh
mixed-elements
```
