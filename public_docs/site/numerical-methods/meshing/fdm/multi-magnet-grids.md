---
title: FDM Multi-Magnet Grids
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fdm-multi-magnet-grids)=
# FDM Multi-Magnet Grids

Each magnetic object may own a native Cartesian grid. Nonlocal demagnetization can additionally use
a common convolution grid.

```text
native object state ── prolong/restrict ── common convolution grid
```

The common grid is a communication space, not ownership of magnetization. Its dimensions, spacing,
mask transfer, volume weighting, precision, and cache identity must be recorded.

The `single_grid` and `multilayer_convolution` strategies are distinct execution contracts. Silent
fallback from a requested multilayer route to a single grid is forbidden.
