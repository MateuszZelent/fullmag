---
title: Mesh State Transfer
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-state-transfer)=
# Mesh state transfer

Changing FDM/FEM representation creates a new discrete state. The runtime transfers magnetization,
not assembled operators, demagnetizing potentials, solver histories, or discrete energy.

Backend transfer evidence records:

- source and target mesh/grid digests and coordinate frames;
- FEM-to-FDM barycentric or FDM-to-FEM Cartesian interpolation family;
- requested, interpolated, outside, discarded, fallback, and degenerate-vector counts;
- pre-normalization norm statistics and unit-vector normalization policy;
- target finite-value and norm validation;
- source and initial-target energy, torque, and selected observable discontinuities.

Pointwise interpolation is not a conservative projection. A visually smooth transfer can still have
a large exchange-energy, topology, or branch error. Cross-backend continuation should normally
recompute all target operators and may require target-backend re-relaxation.
