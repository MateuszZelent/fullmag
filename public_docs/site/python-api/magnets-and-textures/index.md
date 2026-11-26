---
title: Magnets and Textures
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-root)=
# Magnets and Textures

Magnets carry magnetization, and textures define their initial magnetic state. Author a
ferromagnet (including object-scoped absorbing boundary layers), assign a uniform,
deterministic-random, or sampled state, or initialize vortices, antivortices, Bloch and Neel
skyrmions, antiskyrmions, skyrmionium targets, skyrmion lattices, three-dimensional hopfions and
Bloch points, bimerons, domain walls, two-domain states, helices, conical and general spirals,
and artificial spin-ice configurations.
The preset reference documents the implemented equations, versioning, coordinate mapping,
clamp/tiling and slab-thickness modes, FEM/FDM materialization, validation, and current
limitations.

```{toctree}
:maxdepth: 1

ferromagnet
initial-magnetization
uniform-texture
preset-textures
mumax3-compatibility
```
