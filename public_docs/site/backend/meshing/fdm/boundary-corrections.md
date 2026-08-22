---
title: FDM Boundary Corrections
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fdm-boundary-corrections)=
# FDM boundary corrections

The public boundary-correction vocabulary is:

| Request | Intended realization |
|---|---|
| `none` | ordinary binary-mask boundary treatment |
| `volume` | volume-fraction correction with optional fraction floor |
| `full` | embedded/cut-boundary correction with fraction and geometric-distance stabilization |

`boundary_phi_floor` is dimensionless and strictly between zero and one.
`boundary_delta_min` is a nonnegative SI length.

Support is interaction- and device-specific. A field being present in `FDM.to_ir()` does not prove
that every exchange, DMI, demagnetization, CPU, and GPU kernel consumes it. The resolved report must
name the correction used by each affected operator and reject an unsupported product in strict mode.

Validation includes magnetic-volume convergence, constant-state null tests, rotated-geometry tests,
energy/field consistency, and CPU/GPU parity on an identical mask/fraction digest.
