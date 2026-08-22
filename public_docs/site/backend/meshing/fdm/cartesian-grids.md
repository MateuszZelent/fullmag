---
title: Cartesian Grids
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fdm-cartesian-grids)=
# Cartesian grids

For origin $\mathbf{x}_0$, spacing $(h_x,h_y,h_z)$, and integer indices $(i,j,k)$, the cell centre is

```{math}
\mathbf{x}_{ijk}=\mathbf{x}_0+
\left((i+\tfrac12)h_x,(j+\tfrac12)h_y,(k+\tfrac12)h_z\right).
```

The backend resolves:

- integer dimensions and allocation bounds;
- component and memory ordering;
- active and material masks;
- cell volume and optional volume/face fractions;
- free, periodic, and material-interface neighbour relations;
- open-convolution padding and kernel-spectrum identity;
- host or device storage and precision.

A nominal cell size is insufficient provenance. Results must retain the realized origin, shape,
spacing, mask digest, periodic policy, padding, and grid fingerprint.

Primary schema ownership is in `fullmag.model.discretization.FDM` and `FDMGrid`; interaction pages
own the exact boundary stencil used on this grid.
