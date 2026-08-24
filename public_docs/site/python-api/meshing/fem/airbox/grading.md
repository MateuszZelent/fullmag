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

Advanced policy keys include airbox hmin/hmax, growth, geometric/linear grading, curvature, and
narrow-region resolution. These are targets, not guaranteed realized extrema.
