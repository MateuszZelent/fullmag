---
title: Backend
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/architecture/backend-golden-masterplan.md
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

Backend authority is explicit: production FDM implementations live under `backends/fdm`, production
FEM implementations under `backends/fem`, and the Rust CPU/reference path remains the trusted oracle.
Runner and session code orchestrate those lanes; they do not own a second copy of production physics.
Source presence, successful compilation, executable runtime support, and scientific qualification are
separate evidence levels.

Python authoring is documented separately under {doc}`../python-api/index`; Control Room behavior
under {doc}`../frontend/index`.

```{toctree}
:maxdepth: 4

../architecture/index
../physics/index
../numerical-methods/meshing/index
../numerical-methods/index
```
