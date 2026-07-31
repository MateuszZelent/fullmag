---
title: Meshing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-root)=
# Meshing

Meshing is split by realization: Cartesian FDM cells, shared-domain FEM meshes, airbox extent,
swept thin-film topology and refinement controls. Mesh choices are numerical semantics and must be
recorded with solver, backend, precision and provenance; they are not interchangeable presentation
settings.

```{toctree}
:maxdepth: 1

fdm-grids
fem-shared-domain
airbox
swept-meshes
refinement
```
