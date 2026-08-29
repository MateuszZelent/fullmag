---
title: Backend
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-root)=
# Backend

The Backend branch owns physical equations, numerical realization, data flow, runtime contracts, and
scientific evidence. It answers **what FullMag executes**, not how a UI widget is arranged or which
Python spelling a user types.

The branch is divided into:

- architecture and runtime boundaries;
- physics and interaction definitions;
- meshing and spatial discretization;
- numerical solvers and stage algorithms.

Python authoring is documented separately under {doc}`../python-api/index`; Control Room behavior
under {doc}`../frontend/index`.

```{toctree}
:maxdepth: 4

../architecture/index
../physics/index
../numerical-methods/meshing/index
../numerical-methods/index
```

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
