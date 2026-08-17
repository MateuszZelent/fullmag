---
title: Getting started
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-root)=
# Getting started

FullMag lets you author one physical micromagnetics problem in Python or in the interactive
Control Room, lower it to the canonical `ProblemIR`, and execute it across finite-difference
(FDM) and finite-element (FEM) backends. The getting-started pages take you from installation to
your first runnable simulation.

## What you will do here

1. **{doc}`Installation <installation>`** — install the embedded Python DSL and prepare a solver
   runtime.
2. **{doc}`First FDM Simulation <first-fdm-simulation>`** — author and run a small finite-difference
   relaxation with `fm.study(...)` and ordered stages.
3. **{doc}`First FEM Simulation <first-fem-simulation>`** — author and run the same physical idea on a
   finite-element mesh with a Poisson airbox demagnetization solve.
4. **{doc}`Choosing a Solver <choosing-a-solver>`** — decide between FDM and FEM, and between CPU and
   GPU execution, without overstating what is qualified today.
5. **{doc}`Control Room <control-room>`** — use the interactive web workspace that round-trips to the
   same Python model.

## The canonical workflow

Every public simulation script follows the repository-owned stage scenario. You configure a
`fm.study(...)` with engine, device and mode, define the universe and geometry, assign material and
magnetization state, register interactions, and only then append ordered
`study.stages.add_*` stages:

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("getting_started_workflow")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(160 * nm, 160 * nm, 24 * nm))
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 4 * nm))

film = study.geometry(fm.Box(size=(80 * nm, 120 * nm, 8 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.1
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.exchange()
study.demag(realization="poisson_robin")
study.solver(dt=5.0e-13, g=2.211e5)
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", dt=5.0e-13, tolA=1.0e-4)
```

Direct `fm.Problem(...)` construction is **not** part of the public workflow. It describes a
structural snapshot, while `fm.study(...)` plus ordered `study.stages.add_*` stages is the normal,
physics-first authoring path taught throughout this manual.

The planner reports an unsupported engine, device, precision, or interaction combination instead of
silently changing your request. Requested intent and resolved execution stay separate, so a result
always carries the backend that produced it.

```{toctree}
:maxdepth: 1

installation
control-room
first-fdm-simulation
first-fem-simulation
choosing-a-solver
```
