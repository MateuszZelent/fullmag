---
title: Magnets and Textures
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-root)=
# Magnets and Textures

Magnets carry magnetization, and textures define their initial magnetic state. Author a
ferromagnet, assign a uniform or deterministic-random state, or initialize vortices, antivortices,
Bloch and Neel skyrmions, antiskyrmions, skyrmionium targets, three-dimensional hopfions,
bimerons, domain walls, two-domain states, helices, and conical spirals.
The preset reference documents the implemented equations, versioning, coordinate mapping, FEM/FDM
materialization, validation, and current limitations.

```{toctree}
:maxdepth: 1

ferromagnet
initial-magnetization
uniform-texture
preset-textures
mumax3-compatibility
```
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Magnetization` for supported texture controls. Presets or parameters without a matching control are `TODO: frontend support`; do not claim UI support from Python availability. See {doc}`/frontend/capability-register`.

## API and source scope

This page is a navigation index. Terminal texture pages own the exact equations, coordinate conventions, Python arguments, validation, bibliography, and source-code index.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
