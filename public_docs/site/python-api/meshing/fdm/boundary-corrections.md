---
title: FDM Boundary-Correction API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-boundary-corrections)=
# FDM boundary-correction API

The `FDM` constructor accepts:

| Field | Type | Unit | Validation |
|---|---|---:|---|
| `boundary_correction` | string or `None` | 1 | `none`, `volume`, or `full` |
| `boundary_phi_floor` | float or `None` | 1 | strictly between zero and one |
| `boundary_delta_min` | float or `None` | m | finite and nonnegative |

Constructor syntax:

```text
fm.FDM(
    default_cell=(2e-9, 2e-9, 1e-9),
    boundary_correction="volume",
    boundary_phi_floor=0.05,
)
```

These fields author requested intent. Interaction/device capability determines whether the selected
correction is executable. Strict mode rejects unsupported combinations; the runtime report must
identify the realized correction rather than inferring it from the request.
