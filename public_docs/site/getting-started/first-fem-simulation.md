---
title: First FEM Simulation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-first-fem-simulation)=
# First FEM Simulation

This page runs the finite-element counterpart of the FDM onboarding example. The same film relaxes
from a uniform magnetization, but the domain is an unstructured tetrahedral mesh and the
magnetostatic field is solved with a Poisson airbox formulation instead of an FFT convolution.

## What the example computes

A universe of $160 \times 160 \times 24\ \mathrm{nm}$ surrounds a $80 \times 120 \times 8\ \mathrm{nm}$
ferromagnetic film. The film is resolved with $4\ \mathrm{nm}$ elements while the surrounding air
region is coarsened, so the airbox supports the magnetostatic Poisson solve without paying
four-nanometer resolution far from the magnet. The demagnetization linear system is solved with a
conjugate-gradient method and an algebraic multigrid preconditioner.

## Author the study

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("first_fem_simulation")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(160 * nm, 160 * nm, 24 * nm))
study.universe.mesh(maximum_element_size=40 * nm, maximum_element_growth_rate=1.7)

film = study.geometry(
    fm.Box(size=(80 * nm, 120 * nm, 8 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.1
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh(maximum_element_size=4 * nm, order=1)

study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1.0e-10, max_iterations=500)
study.build_domain_mesh()

study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=2000,
    tolT=5.0e-9,
).tableautosave(
    every_steps=10,
    quantities=["step", "mx", "my", "mz", "e_ex", "e_demag", "e_total", "max_torque_T"],
)
```

## What each part does

- `study.engine("fem")` selects the finite-element backend.
- `study.universe.mesh(...)` sizes the airbox elements with a growth-rate bound so the magnet is
  resolved finely while air elements grow away from it.
- `film.mesh(maximum_element_size=4 * nm, order=1)` overrides the local element size on the magnetic
  body.
- `study.demag(realization="poisson_robin")` chooses the scalar-potential Poisson demagnetization
  formulation; the alternative public FEM strategy is the boundary-element method documented on the
  {ref}`demagnetization pages <public-docs-physics-interactions-root>`.
- `study.fem_demag_solver(...)` configures the linear solver for the Poisson system.
- `study.build_domain_mesh()` realizes the domain mesh from the universe plus body before lowering.
- `study.stages.add_relax(algorithm="projected_gradient_bb", tolT=5.0e-9, ...)` relaxes with the
  projected Barzilai-Borwein gradient method until the torque magnitude in tesla falls to the
  requested tolerance or the step budget is spent. This projected-gradient method does not need an
  LLG timestep, unlike the overdamped stage used on the FDM page.

## Run headlessly

Save the block as `first_fem_simulation.py`. The FEM runtime is built and executed through the
repository's managed runtime recipes:

```console
just ensure-managed-fem-runtime
just fem-managed-headless cpu first_fem_simulation.py
```

The managed runtime records the resolved backend, device, and precision in the result. To request the
FEM GPU lane instead, pass `gpu` as the execution mode to the same recipe and verify the device
identity in the produced provenance.

## Reading the result

`max_torque_T` is the maximum torque magnitude reported in tesla and is the relaxation stop signal,
while `e_ex`, `e_demag` and `e_total` are the exchange, demagnetization and total energies. Autosave
tables are scalar time series; mesh and field snapshots are separate artifacts.

## Limits of this example

Unstructured-mesh relaxation has stricter tolerance and meshing regimes than the small onboarding
grid shown here. μMAG Standard Problem 4 and the analytical validation pages provide the
qualification evidence for those regimes. FEM GPU execution requires a managed CUDA runtime and is
not claimed by this snippet.
