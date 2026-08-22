---
title: Discretization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-root)=
# Discretization

This branch retains low-level constructor, compatibility, hybrid, and canonical-lowering references.
For normal simulation authoring, use the workflow-oriented {doc}`../meshing/index` tree, where FDM
and FEM are separate and FEM is divided into ferromagnet and airbox subtrees.

The pages below remain stable for existing links and for readers inspecting the raw
`DiscretizationHints`, `FDM`, `FEM`, and compatibility schemas.

```{toctree}
:maxdepth: 1

discretization-hints
fdm
fdm-multilayer-convolution
fem
hybrid
mesh-controls
per-object-meshing
```

## Ownership rule

- **Meshing** owns user workflows, topology selection, airbox, body meshes, build lifecycle, and
  reports.
- **Discretization** owns low-level data containers and historical API locations.
- **Backend** owns the realized numerical grid or mesh.

No low-level page should be used to infer that a represented topology is executable on a particular
backend/device lane.
