---
title: FDM Grid API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-grids)=
# FDM grid API

## Study-first helpers

```text
study.objects.mesh.defaults(cell_size=(dx, dy, dz))
magnet.mesh(cell_size=(dx, dy, dz))
```

The first call defines the inherited native spacing. The second overrides it for one object.

## Typed objects

| API | Fields | Validation |
|---|---|---|
| `FDMGrid(cell=...)` | positive three-vector | exactly three finite SI lengths |
| `FDM(default_cell=...)` | positive three-vector | required unless `per_magnet` is nonempty |
| `FDM(per_magnet={name: FDMGrid(...)})` | object-to-grid map | nonempty string names and typed grid values |
| legacy `FDM(cell=...)` | alias of `default_cell` | cannot coexist with `default_cell` |

Object extents, origin, integer dimensions, active masks, and padding are resolved later. Python
stores intent; the runtime report stores the exact grid consumed by the solver.
