---
title: Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-root)=
# Python API

FullMag's public authoring surface is the embedded Python DSL
(`import fullmag as fm`). Every public script is a stage-first `fm.study(...)` with ordered
`study.stages.add_*` calls; the DSL lowers to the canonical `ProblemIR` that the planner and
runtime execute.

The pages here cover the constructor surface, geometry and materials, magnets and textures,
interactions, current and excitations, boundary conditions, discretization, dynamics, studies,
outputs, and the runtime lifecycle. Direct `fm.Problem(...)` construction is not part of the
public workflow.

```{toctree}
:maxdepth: 1

problem/index
geometry/index
materials/index
magnets-and-textures/index
interactions/index
current-and-excitations/index
boundary-conditions/index
discretization/index
dynamics/index
studies/index
outputs/index
runtime/index
```
