---
title: FEM
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-fem)=
# FEM

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `FEM.order` | `int` | required | $1$ | Positive finite-element order. |
| `FEM.maximum_element_size` | positive `float` | required unless `hmax` is supplied | $\mathrm{m}$ | Canonical maximum element size. Construction fails if neither spelling is provided. |
| `FEM.hmax` | positive `float \| None` | `None` | $\mathrm{m}$ | Alternate input spelling for the same required size; unequal simultaneous values are rejected. |
| `FEM.mesh` | `str \| None` | `None` | — | Optional imported mesh reference. |
| `FEM.demag_solver_policy` | policy or `None` | `None` | — | Demagnetization linear-solver policy. |
