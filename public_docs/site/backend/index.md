---
title: Backend
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-root)=
# Backend

This branch documents numerical realization: mesh construction, operator assembly, solver
selection, CPU/GPU execution, runtime resources, artifacts, and provenance. It answers **what the
backend actually did**, not merely what Python or Control Room requested.

```{toctree}
:maxdepth: 5

meshing/index
../numerical-methods/index
../architecture/index
```

## Backend evidence hierarchy

| Evidence | Establishes |
|---|---|
| source/API symbol exists | representability only |
| planner selects a lane | intended resolved execution |
| runtime provenance names the lane | actual orchestration path |
| device/residency/transfer evidence | where operators and vectors executed |
| residual, quality, convergence and benchmark evidence | numerical or scientific qualification |

The backend keeps requested intent and resolved execution separate. In strict mode, an unsupported
combination is rejected instead of silently changing device, topology, solver, boundary condition,
or physical model.
