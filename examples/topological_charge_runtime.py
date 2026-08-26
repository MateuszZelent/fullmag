"""Interactive planar topological-charge fixture for managed FDM/FEM proof.

Select the native discretization through ``FULLMAG_TOPOLOGICAL_CHARGE_BACKEND``
(``fdm`` or ``fem``).  The fixture intentionally exposes one magnetic film
with analytic Neel initial magnetization and keeps the session alive for the
v2 analysis resource capture.
"""

from __future__ import annotations

import os

import fullmag as fm


BACKEND = os.environ.get("FULLMAG_TOPOLOGICAL_CHARGE_BACKEND", "fdm").strip().lower()
if BACKEND not in {"fdm", "fem"}:
    raise ValueError("FULLMAG_TOPOLOGICAL_CHARGE_BACKEND must be fdm or fem")

study = fm.study(f"topological_charge_runtime_{BACKEND}")
study.engine(BACKEND)
study.device("cpu", precision="double")
study.interactive(True)
study.wait_for_solve(False)
study.universe(
    mode="manual" if BACKEND == "fdm" else "auto",
    size=(160e-9, 160e-9, 12e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)

if BACKEND == "fdm":
    study.cell(5e-9, 5e-9, 4e-9)
else:
    study.universe.mesh(minimum_element_size=3e-9, maximum_element_size=20e-9)

film = study.geometry(
    fm.Box(size=(120e-9, 120e-9, 8e-9), name="topological_charge_film"),
    name="topological_charge_film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.5
film.m = fm.texture.neel_skyrmion(
    radius=30e-9,
    wall_width=5e-9,
    chirality=1,
    core_polarity=-1,
)
if BACKEND == "fem":
    film.mesh(minimum_element_size=5e-9, maximum_element_size=10e-9, order=1)

study.demag(realization="poisson_robin")
study.solver(dt=1e-13)
study.stages.add_relax(algorithm="llg_overdamped", max_steps=1, tolA=1e-3)
