---
title: Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-root)=
# Python API

FullMag's public authoring surface is the embedded stage-first Python DSL
(`import fullmag as fm`). The tree is organized by authoring owner.

Meshing is a dedicated family with separate FDM and FEM branches. Within FEM, ferromagnet and
airbox commands are separated, and every topology mode has its own page. Low-level composite
discretization objects remain in a small compatibility branch instead of mixing with mesh workflows.

```{toctree}
:maxdepth: 4

problem/index
geometry/index
materials/index
magnets-and-textures/index
interactions/index
current-and-excitations/index
boundary-conditions/index
meshing/index
discretization/index
dynamics/index
studies/index
outputs/index
runtime/index
```
