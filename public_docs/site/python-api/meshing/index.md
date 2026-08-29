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
{doc}`../../numerical-methods/meshing/index`; matching Control Room panels under
{doc}`../../frontend/meshing/index`.

```{toctree}
:maxdepth: 4

fdm/index
fem/index
```

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
