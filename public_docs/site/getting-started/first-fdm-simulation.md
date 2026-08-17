---
title: First FDM Simulation
status: partial
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

A film of size $160 \times 160 \times 24\ \mathrm{nm}$ is discretized on a regular FDM grid with
$4\ \mathrm{nm}$ cells. The magnetic body is $80 \times 120 \times 8\ \mathrm{nm}$, so the resolved
geometry sits inside the discretization universe. Exchange stiffness $A_{\mathrm{ex}}$ and the
magnetostatic field drive the magnetization toward a local minimum; the overdamped LLG relaxation
stage stops when the requested torque/field tolerance or step budget is reached.

## Author the study

```python
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
- `study.exchange()` and `study.demag(realization="poisson_robin")` register the two interactions.
- `study.stages.add_relax(...)` declares the ordered relaxation stage; its `.tableautosave(...)`
  records per-step scalars.

The relaxation requires an explicit timestep policy, which is why `dt=5.0e-13` is supplied both to
the solver defaults and to the stage.

## Run headlessly

Save the block above as `first_fdm_simulation.py` and run it through the repository launcher:

```console
just run-headless first_fdm_simulation.py
```

This builds the local runtime on first use, executes the stage, and writes per-stage scientific
artifacts and the autosave table to the auto-derived output directory. For an interactive run with
the Control Room use `just fullmag build=True fdm cpu first_fdm_simulation.py`.

## Reading the result

The `tableautosave` quantities (`mx`, `my`, `mz`, `E_total`) are scalar observables: the spatially
averaged magnetization components and the total energy respectively. They are the first evidence
that the relaxation is progressing; per-cell field and magnetization snapshots are separate
artifacts selected through stage outputs.

## Limits of this example

This is an onboarding run, not an MD/qualification benchmark. It uses a small cell grid so it is
practical to run; exchange and demagnetization validation regimes are documented on the canonical
{ref}`interaction pages <public-docs-physics-interactions-root>`. The FDM CPU lane shown here has
scoped published evidence; do not infer executed CUDA parity from this snippet.
