---
title: FDM Meshing Backend
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fdm-root)=
# FDM meshing backend

The FDM backend realizes object-owned, cell-centred Cartesian grids. Grid generation determines
cell centres, masks, volumes, local stencils, FFT dimensions, periodic indexing, and device-buffer
layout.

```{toctree}
:maxdepth: 2

cartesian-grids
multilayer-grids
boundary-corrections
```

FDM does not invoke the FEM shared-domain mesh builder. Curved boundaries are represented through
active masks and, where qualified, volume or embedded-boundary corrections.
