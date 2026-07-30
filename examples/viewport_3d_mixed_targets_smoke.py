"""Strict mixed-P1 FEM fixture for the viewport-3D browser smoke.

Run with:
    fullmag --dev -i examples/viewport_3d_mixed_targets_smoke.py
"""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
MAX_STEPS = int(os.environ.get("FULLMAG_VIEWPORT3D_MIXED_TARGET_MAX_STEPS", "50"))


fm.reset()
study = fm.study("viewport_3d_mixed_targets_smoke")
study.mode("strict")
study.engine("fem")
study.device("gpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)

study.universe(
    mode="manual",
    size=(100 * NM, 80 * NM, 65 * NM),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=10 * NM,
    minimum_element_size=3 * NM,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)
study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff", wireframe=False)

film = study.geometry(
    fm.Box(size=(40 * NM, 20 * NM, 3 * NM), name="film"),
    name="film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.Ku1 = 0.0
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh.thin_film(
    maximum_element_size=3 * NM,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
film.visualization(show=True, mode="surface", active_quantity_id="m")

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()

study.solver(dt=1e-15, integrator="heun", g=2.115)
study.save("m", every=1e-12)
study.tableautosave(1e-12, quantities=["t", "step", "mx", "my", "mz", "E_total"])

study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk45",
    max_error=1e-4,
    dt_min=1e-15,
    dt_max=1e-13,
    max_steps=MAX_STEPS,
    tolA=1e-4,
)
