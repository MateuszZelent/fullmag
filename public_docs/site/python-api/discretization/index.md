---
title: Low-Level Discretization Hints
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-root)=
# Low-Level Discretization Hints

This compatibility branch contains composite `DiscretizationHints` and `Hybrid` objects.

FDM and FEM mesh authoring has moved to the dedicated {doc}`../meshing/index` branch. The old
terminal URLs remain available through redirects, but they are no longer the canonical navigation
owners.

```{toctree}
:maxdepth: 1

discretization-hints
hybrid
```
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Mesh` for advertised mesh fields. The legacy `DiscretizationHints` and `Hybrid` branch has no separate authoring screen; `TODO: frontend support` applies to those compatibility-only fields. Canonical FDM/FEM routes are documented under {doc}`../meshing/index` and the capability register {doc}`/frontend/capability-register`.

## API and source scope

This index does not introduce a separate numerical model. Exact equations, Python signatures, backend realization, limitations, bibliography, and source references belong to the terminal pages and the canonical meshing branch.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
