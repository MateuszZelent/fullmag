---
title: Meshing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-root)=
# Meshing

This branch is the canonical workflow-oriented Python reference for spatial discretization. FDM and
FEM are separate because they author different state spaces, geometry representations, and build
lifecycles.

```{toctree}
:maxdepth: 4

fdm/index
fem/index
shared-controls
```

## Select a lane

| Study engine | Start here | Main authored quantity |
|---|---|---|
| `study.engine("fdm")` | {doc}`fdm/index` | cell spacing, native object grids, masks and convolution-grid policy |
| `study.engine("fem")` | {doc}`fem/index` | element order, object mesh recipes, shared domain and airbox |

The older {doc}`../discretization/index` branch remains a low-level type and compatibility reference.
New simulation setup should follow this Meshing tree.

## Common rules

- all lengths are SI metres;
- omitted object values inherit through the documented precedence chain;
- requested values are mesher targets, not measured properties of the final mesh;
- geometry or mesh-policy changes invalidate the current spatial realization;
- strict mode rejects unsupported combinations rather than silently changing topology;
- reports and provenance, not authoring alone, establish what executed.
