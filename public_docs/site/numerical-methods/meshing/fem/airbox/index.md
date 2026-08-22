---
title: FEM Airbox Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-airbox-root)=
# FEM Airbox Meshing

The airbox is a nonmagnetic exterior volume used by scalar-potential magnetostatics. Its geometry,
mesh grading, outer marker, and periodic topology are independent numerical parameters.

The existing Airbox overview provides the full truncation and convergence discussion; the modules
below separate geometry, grading, closure, and periodic variants.

```{toctree}
:maxdepth: 2

../../airbox
geometry
grading
boundary-closure
periodic-airbox
```
