---
title: Airbox Geometry API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-geometry)=
# Airbox Geometry API

Use:

```text
study.universe(mode="manual", size=(Lx, Ly, Lz))
```

The same Python call supports `padding` and explicit `center`; all lengths are SI metres. The
current `study.universe(...)` signature does not expose an airbox-shape selector. Runtime/API mesh
resources may report a resolved shape, but that read model is not an additional Python authoring
parameter. Realized clearances and shape come from the build report.
