---
title: First FDM Simulation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-first-fdm-simulation)=
# First FDM Simulation

This page runs a small finite-difference relaxation: a soft ferromagnetic film with exchange and
magnetostatic interactions relaxes from a uniform magnetization under its own effective field. The
example follows the stage-first `fm.study(...)` workflow and never constructs a `fm.Problem(...)`
snapshot.

## What the example computes

A computational universe of size $160 \times 160 \times 24\ \mathrm{nm}$ is discretized on a regular FDM grid with
$4\ \mathrm{nm}$ cells. The magnetic body is $80 \times 120 \times 8\ \mathrm{nm}$, so the resolved
geometry sits inside the discretization universe. Exchange stiffness $A_{\mathrm{ex}}$ and the
magnetostatic field drive the magnetization toward a local minimum; the overdamped LLG relaxation
stage stops when the requested torque/field tolerance or step budget is reached.

## Author the study

```python
# %% Author the study
import fullmag as fm

nm = 1.0e-9
study = fm.study("first_fdm_simulation")
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
study.demag()
study.solver(fix_dt=5.0e-13, gamma=2.211e5)

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

## What each part does

- `fm.study("first_fdm_simulation")` opens the study builder.
- `study.engine("fdm")` selects the finite-difference backend; the finite-element alternative is
  `study.engine("fem")`.
- `study.device("cpu", precision="double")` requests CPU execution in double precision. This is a
  requested intent; the runtime records the resolved backend and device independently.
- `study.mode("strict")` selects the strict execution mode, so validation rejects unsupported
  combinations instead of silently changing them.
- `study.universe(...)` defines the discretization domain. `mode="manual"` means FullMag does not
  automatically grow the domain.
- `study.objects.mesh.defaults(cell_size=(...))` sets the FDM cell size for the object grid.
- `film.Ms`, `film.Aex` and `film.alpha` set saturation magnetization
  $\mathrm{A\,m^{-1}}$, exchange stiffness $\mathrm{J\,m^{-1}}$ and the Gilbert damping
  parameter ($1$, dimensionless).
- Exchange and demagnetization are registered by default. `film.Aex` supplies the exchange
  stiffness; it is not an enable call. Use `study.disable_exchange()` or
  `study.disable_demag()` only for an intentional opt-out.
- `study.solver(fix_dt=..., gamma=...)` sets the fixed solver timestep and the positive
  gyromagnetic ratio in $\mathrm{m\,A^{-1}\,s^{-1}}$.
- `study.stages.add_relax(...)` declares the ordered relaxation stage; its `.tableautosave(...)`
  records per-step scalars.

The relaxation uses an explicit fixed timestep. `fix_dt=5.0e-13` defines the solver-level default,
while the stage-level `dt=5.0e-13` records the timestep requested for this relaxation stage.

## Run in the Docker DEV group

Save the block above inside your checkout (for example as `first_fdm_simulation.py`, or run the
tracked smoke scenario `examples/fdm_cpu_relax_smoke.py`) and execute it through your Docker
Compose DEV group:

```console
just fullmag-dev-container first_fdm_simulation.py
```

If your group is already running with an empty workspace (`just docker-dev "$PWD"`), activate the
script directly without restarting containers:

```console
just docker-dev-script first_fdm_simulation.py
```

This lowers the model to `ProblemIR`, validates the CPU FDM lane, runs the relaxation stage, and
writes per-stage scientific artifacts and scalar autosave tables to the configured host storage. To
drive the same workflow line-by-line from a terminal or Jupyter notebook while watching the Control
Room update live, see {doc}`interactive-python` (`fm.connect()`).

## Reading the result

The `tableautosave` quantities (`mx`, `my`, `mz`, `E_total`) are scalar observables: the spatially
averaged magnetization components and the total energy respectively. They are the first evidence
that the relaxation is progressing; per-cell field and magnetization snapshots are separate
artifacts selected through stage outputs.

```{figure} /_static/images/ui/viewport-3d-interactive.png
:alt: Interactive 3D Viewport showing normalized magnetization glyphs and surface colormaps
:class: fm-ui-figure
:width: 100%

Inspecting relaxed 3D magnetization glyphs ($\mathbf{m}$ colored by $m_z$ / component colormaps) inside the Control Room 3D viewport.
```

## Limits of this example

This is an onboarding run, not a scientific qualification benchmark. It uses a small cell grid so it is
practical to run; exchange and demagnetization validation regimes are documented on the canonical
{ref}`interaction pages <public-docs-physics-interactions-root>`. The FDM CPU lane shown here has
scoped published evidence; do not infer executed CUDA parity from this snippet. Authoring and
`ProblemIR` validation alone do not establish mesh convergence, solver execution, or GPU parity.

## Source-code index

- `packages/fullmag-py/src/fullmag/world.py` — `StudyBuilder`, `StudyStagesBuilder`: stage-first authoring and capture.
- `packages/fullmag-py/src/fullmag/model/problem.py` — `Problem.to_ir`: canonical serialization and validation.
- `justfile` — `docker-dev`, `docker-dev-script`, `fullmag-dev-container`: Docker Compose DEV launch and script execution recipes.
