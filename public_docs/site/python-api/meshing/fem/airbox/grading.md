---
title: Airbox Grading API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-grading)=
# Airbox Grading API

Use `study.universe.mesh(...)` for air sizing:

```text
study.universe.mesh(
    minimum_element_size=8e-9,
    maximum_element_size=100e-9,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)
```

The public Python facade exposes hmin/hmax aliases, growth, and `auto`/`geometric`/`linear` grading.
Curvature and narrow-region controls belong to object mesh policy, not the current
`study.universe.mesh(...)` signature. These values are targets, not guaranteed realized extrema.
