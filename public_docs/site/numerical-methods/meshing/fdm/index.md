---
title: FDM Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fdm-root)=
# FDM Meshing

FDM meshing defines a cell-centred Cartesian state space. It is not a Gmsh workflow and has no
tetrahedral, prism, or airbox-element mode.

This branch separates the native grid, embedded-boundary correction, multi-magnet/common-grid
communication, and periodic-grid contracts.

```{toctree}
:maxdepth: 2

../fdm-grids
boundary-correction
multi-magnet-grids
periodic-grids
```
