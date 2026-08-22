---
title: Airbox Meshing API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-root)=
# Airbox meshing API

Airbox authoring belongs to `study.universe(...)` and `study.universe.mesh(...)`, not to a magnetic
object.

```{toctree}
:maxdepth: 2

geometry
grading
```

The universe policy is resolved independently from object recipes. It supplies exterior geometry,
air mesh targets, and outer-boundary ownership to the final shared-domain build.
