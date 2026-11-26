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

- architecture, capability planning, runtime transport, and provenance boundaries;
- physics foundations and canonical interaction definitions;
- meshing and spatial discretization (FDM grids and conforming FEM shared-domain / `pure_prism_p2` meshes);
- numerical solvers, stage algorithms, and {ref}`computational optimizations and hardware acceleration <numerical-methods-performance>`.

Python authoring is documented separately under {doc}`../python-api/index`; Control Room behavior
under {doc}`../frontend/index`.

```{toctree}
:maxdepth: 4

../architecture/index
../physics/index
../numerical-methods/meshing/index
../numerical-methods/index
```
