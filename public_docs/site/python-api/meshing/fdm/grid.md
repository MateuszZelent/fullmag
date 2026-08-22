---
title: FDM Default Grid
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-grid)=
# FDM Default Grid

Use the study/object mesh facade for ordinary scripts:

```text
study.objects.mesh.defaults(cell_size=(dx, dy, dz))
```

The tuple is the native cell size in metres. Object extents, integer shape, origin, active mask, and
padding are resolved later. The lower-level equivalent is `FDM(default_cell=(dx, dy, dz))`; the
legacy `cell=` alias is accepted only when `default_cell=` is absent.

Choose cell size from physical length scales and verify convergence. The API does not round an
invalid request into a silently different scientific model.
