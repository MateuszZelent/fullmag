---
title: FDM Periodic Grids
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fdm-periodic-grids)=
# FDM Periodic Grids

Periodic FDM combines the native grid with periodic-axis and demagnetization policy.

Relevant provenance includes:

- periodic axes and cell counts;
- lattice translations;
- image counts for truncated-image approximations;
- FDM demagnetization policy (`open` or `truncated_images`); `periodic_airbox_k0` is FEM-only and
  must be rejected for FDM;
- padded/reciprocal convolution dimensions;
- kernel-spectrum digest.

Open zero padding, finite image summation, and an exact periodic operator are different boundary
problems. Increasing image counts is a convergence study, not a change in sample size.
