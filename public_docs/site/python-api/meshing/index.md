---
title: Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-root)=
# Meshing

Python meshing is divided first by discretization:

- **FDM** — native cell-centred grids, per-magnet overrides, boundary correction, and multilayer
  convolution policy;
- **FEM** — study defaults, ferromagnet topology, airbox, regions, build, and quality.

This branch owns public commands and lowering. Backend algorithms are under
{doc}`../../numerical-methods/meshing/index`; matching Control Room panels under
{doc}`../../frontend/meshing/index`.

```{toctree}
:maxdepth: 4

fdm/index
fem/index
```
