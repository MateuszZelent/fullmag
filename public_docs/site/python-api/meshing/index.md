---
title: Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-root)=
# Meshing

Python meshing is divided first by discretization:

- **FDM** — native cell-centred grids, per-magnet overrides, boundary correction, and multilayer
  convolution policy;
- **FEM** — study defaults, ferromagnet topology, airbox, regions, build, and quality.

This branch owns public commands and lowering. Backend algorithms are under
{doc}`../../numerical-methods/meshing/index`, and GPU/CPU performance realizations are under
{ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-demag`;
matching Control Room panels live under {doc}`../../frontend/meshing/index`
(`MeshRootInspectorSpecPanel`, `ObjectMeshInspectorSpecPanel`, `ObjectRegionMeshInspectorPanel`,
Airbox Mesh Parameters, and interactive FDM structured-grid sizing and inspection).

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Semantic Inspector panel for FEM object mesh sizing and airbox configuration
:width: 92%
```

```{toctree}
:maxdepth: 4

fdm/index
fem/index
```
