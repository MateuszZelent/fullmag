---
title: FDM Boundary-Correction API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-boundary-correction)=
# FDM Boundary-Correction API

`FDM.boundary_correction` accepts `none`, `volume`, or `full`.

| Field | Unit | Constraint |
|---|---|---|
| `boundary_correction` | 1 | supported name |
| `boundary_phi_floor` | 1 | value in `(0, 1)` |
| `boundary_delta_min` | m | nonnegative |

These values request a policy. The result provenance must state the resolved interaction/device
coverage. Do not infer that every CUDA or DMI kernel applied the correction from successful Python
construction alone.
