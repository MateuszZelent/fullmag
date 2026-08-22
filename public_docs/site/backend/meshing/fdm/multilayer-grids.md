---
title: Multilayer And Common Grids
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fdm-multilayer-grids)=
# Multilayer and common grids

A multi-magnet FDM study may retain a native grid for each magnet while using a common convolution
grid for nonlocal demagnetization.

```text
native magnet grid
      │ prolongation / deposition
      ▼
common convolution grid
      │ FFT tensor convolution
      ▼
common demag field
      │ restriction / sampling
      ▼
native magnet grid
```

The planner resolves `single_grid` or `multilayer_convolution` and, for the latter, `two_d_stack` or
`three_d`. Explicit common dimensions and explicit common cell size are mutually exclusive.

A common grid is a communication/operator space, not ownership of magnetization state. Provenance
must identify every native grid, the common grid, coverage, transfer policy, normalization, FFT
padding, and spectra digest. The removed `allow_single_grid_fallback` option cannot authorize a
silent algorithm change.
