---
title: Airbox Grading API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-grading)=
# Airbox grading API

The normal public call is:

```text
study.universe.mesh(
    minimum_element_size=...,
    maximum_element_size=...,
    maximum_element_growth_rate=...,
    grading="geometric" or "linear",
    curvature_factor=...,
    narrow_region_resolution=...,
)
```

The canonical resource fields are `airbox_hmin`, `airbox_hmax`, `airbox_growth_rate`,
`airbox_grading`, `curvature_factor`, and `narrow_region_resolution`.

All sizes are SI metres. Growth, curvature, and narrow-region controls are dimensionless. Blank
fields inherit; they are not serialized as zero. The frontend stores authored values separately from
backend `effective_config`.

FDM resource handling removes FEM-only grading keys and retains only structured-domain geometry.
