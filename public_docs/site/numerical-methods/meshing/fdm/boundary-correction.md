---
title: FDM Boundary Correction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fdm-boundary-correction)=
# FDM Boundary Correction

Boundary correction changes how partially occupied cells and neighbour distances enter local
operators.

| Request | Intended realization |
|---|---|
| `none` | ordinary active-mask/staircase treatment |
| `volume` | volume-fraction correction using `boundary_phi_floor` |
| `full` | full embedded/cut-boundary correction with fraction and distance stabilization |

`boundary_phi_floor` is dimensionless and lies in `(0, 1)`. `boundary_delta_min` is a nonnegative
length. Support is interaction- and device-specific: the presence of the public key does not prove
that every exchange, DMI, demag, CPU, and CUDA kernel implements the requested correction.

Validation requires volume convergence, constant-state null tests, interface flux tests, and
CPU/GPU comparison on the identical mask/fraction digest.
