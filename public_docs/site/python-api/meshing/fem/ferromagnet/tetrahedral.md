---
title: Tetrahedral Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-tetrahedral)=
# Tetrahedral mesh API

Ordinary object authoring uses:

```text
magnet.mesh(
    minimum_element_size=...,
    maximum_element_size=...,
    maximum_element_growth_rate=...,
    order=...,
    compute_quality=True,
)
```

The equivalent explicit recipe sets `mesh_strategy="free_tetrahedral"`. Tetrahedral topology must
not be combined with swept-only fields such as `element_family`, `sweep_direction`,
`transition_policy`, or `exact_layer_count`.

Relevant advanced fields are `algorithm_2d`, `algorithm_3d`, `smoothing_steps`, `optimize`,
`optimize_iters`, curvature controls, narrow-region controls, local size fields, and ordered mesh
operations.

`maximum_element_size` is a target. Inspect the realized report for measured size and quality.
