---
title: Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-root)=
# Geometry

Geometry objects define the physical domain. Create primitives, apply transforms and booleans,
import CAD meshes, select regions, and declare the simulation universe. Geometry is a physics
input: the same object lowers to FDM cells or FEM elements without changing its physical meaning.

```{toctree}
:maxdepth: 1

primitives
transforms
boolean-operations
imported-geometry
regions
universe-and-domain
auxiliary-geometry
```
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Geometry` for supported primitive and transform fields. Boolean, imported-CAD, auxiliary, and other fields without a matching control are `TODO: frontend support`; do not infer an editor from the Python page alone. See {doc}`/frontend/capability-register`.

## API and source scope

This is a navigation index, not an independent constructor contract. Terminal pages own the exact Python example, geometric assumptions, failure semantics, bibliography, and source-code index.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
