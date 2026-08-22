---
title: Getting started
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-root)=
# Getting started

This section installs the Python authoring layer and solver runtime, then introduces the public
stage-oriented workflow for finite-difference (FDM) and finite-element (FEM) simulations. Each
tutorial states the requested backend, device, precision, interactions, mesh, solver, stopping
criteria, and expected artifacts.

## Recommended sequence

1. **{doc}`Installation <installation>`** — install the Python package and prepare an executable
   runtime.
2. **{doc}`First FDM simulation <first-fdm-simulation>`** — run a structured-grid relaxation through
   the CPU FDM lane.
3. **{doc}`First FEM simulation <first-fem-simulation>`** — run the corresponding physical workflow
   on an unstructured FEM mesh with an airbox demagnetization solve.
4. **{doc}`Choosing a solver <choosing-a-solver>`** — select FDM or FEM and CPU or GPU from the
   documented capability and validation scope.
5. **{doc}`Control Room <control-room>`** — author, launch, monitor, and inspect a study through the
   browser interface.

## Public authoring contract

A public script constructs a study, declares its numerical lane and physical domain, assigns
material and magnetization data, registers interactions, and appends ordered stages:

```python
import fullmag as fm

nm = 1.0e-9

study = fm.study("getting_started_workflow")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(160 * nm, 160 * nm, 24 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 4 * nm))

film = study.geometry(
    fm.Box(size=(80 * nm, 120 * nm, 8 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.1
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.exchange()
study.demag(realization="poisson_robin")
study.solver(dt=5.0e-13, g=2.211e5)

study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    dt=5.0e-13,
    tolA=1.0e-4,
    max_steps=2000,
).tableautosave(
    every_steps=50,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
```

The documented interface is `fm.study(...)` with ordered `study.stages.add_*` stages. Direct construction of low-level problem snapshots is not the public user workflow.

## Execution semantics

`study.engine(...)`, `study.device(...)`, `study.mode(...)`, the discretization, and all solver
parameters express requested intent. Before execution, FullMag validates the complete request and
resolves a concrete numerical lane. The result records requested and resolved values separately.

In `strict` mode, an unsupported combination fails before backend startup. The runtime does not
silently replace an interaction, device, precision, solver, or mesh class. A successful run proves
execution only for the resolved lane and workload; it does not establish cross-backend parity or
scientific qualification.

## Running a tracked example

After completing the installation page, execute the repository-owned FDM smoke scenario:

```console
just run-headless examples/fdm_cpu_relax_smoke.py
```

Use the FDM and FEM tutorials for complete copyable studies, expected outputs, and stated limits.

```{toctree}
:maxdepth: 1

installation
first-fdm-simulation
first-fem-simulation
choosing-a-solver
control-room
```
