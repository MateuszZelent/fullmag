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
(`import fullmag as fm`), usable either in **batch stage-first scripts** (`fm.study(...)` and
`study.stages.add_*`) or **interactive live sessions** connected to a running FullMag instance
({doc}`runtime/live-session`, `fm.connect()`). The tree is organized by authoring owner.

Every terminal API page follows the public entry contract and includes a **Control Room crosswalk**
mapping Python constructs to the Control Room v2 workspace, Semantic Inspectors, and visualization
views. Frontend coverage and explicit missing-UI notes are centralized in
{doc}`../frontend/capability-register`.

```{image} /_static/images/ui/control-room-workspace-overview.png
:alt: FullMag Control Room workspace with Ribbon, Model Explorer, interactive 3D Viewport, Semantic Inspector, and status bar
:align: center
:width: 100%
```

Meshing is a dedicated family with separate FDM and FEM branches. Within FEM, ferromagnet and
airbox commands are separated, and every topology mode has its own page. Low-level composite
discretization objects remain in a small compatibility branch instead of mixing with mesh workflows.

## Live & batch round-trip

Interactive REPL / notebook sessions (`fm.connect()`, `fm.transaction()`, `fm.relax()`, `fm.run()`,
`fm.field()`, `fm.table()`, `fm.sweep()`) operate over the same underlying `SceneDocument` and
SI-normalized `ProblemIR` schema as batch scripts, and can export a canonical stage-first Python script
at any time via `fm.export_script()`.

```{image} /_static/images/ui/ribbon-tabs-automation-python.png
:alt: Control Room File menu showing Save canonical copy as... for canonical Python script export alongside the Workspace ribbon and Model Explorer
:align: center
:width: 100%
```

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

## Bibliography

No independent scientific model is introduced by this navigation page. Use the bibliography on the selected terminal page; this statement is an explicit applicability boundary, not an omitted reference.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
