---
title: Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-root)=
# Python API

FullMag's public authoring surface is the embedded Python DSL (`import fullmag as fm`). Every public
simulation is a stage-first `fm.study(...)` with ordered `study.stages.add_*` calls. The DSL lowers
to canonical `ProblemIR`; the planner and numerical backend resolve the executable lane.

The Python tree is organized by **what the script authors**. Meshing is now a first-class branch,
separate from low-level discretization type definitions:

- {doc}`meshing/index` — complete FDM and FEM mesh workflows, including ferromagnet and airbox
  branches and one page per topology;
- {doc}`discretization/index` — lower-level discretization containers, compatibility aliases, and
  hybrid hints;
- {doc}`runtime/index` — execution, results, artifacts, and provenance after authoring.

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
dynamics/index
studies/index
outputs/index
runtime/index
discretization/index
```

## Authoring layers

| Layer | Canonical branch | Owns |
|---|---|---|
| Physical model | geometry, materials, magnets, interactions, boundary conditions | fields, materials, energy terms, drives, constraints |
| Spatial model | {doc}`meshing/index` | FDM cell grids, FEM body meshes, FEM airbox, refinement and topology |
| Temporal/study model | dynamics and studies | LLG integration, relaxation, sweeps, eigenmodes and response |
| Output model | outputs | fields, scalars, snapshots, modes, spectra and autosave |
| Execution model | runtime | backend/device/precision selection, artifacts and provenance |

## Python, Frontend, and Backend cross-reference

Python pages specify accepted commands, parameters, defaults, units, validation, and lowering. For
the same concept:

- use {doc}`../frontend/index` to locate the corresponding Control Room panel and transaction;
- use {doc}`../backend/index` to inspect the actual numerical realization and support boundary;
- use {doc}`../physics/index` for physical equations and conventions.

A Python parameter being representable does not imply that every backend/device/topology product is
executable. Unsupported combinations fail capability validation in strict mode rather than silently
selecting another method.
