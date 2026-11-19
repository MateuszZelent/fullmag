"""Mixed-P1 FEM fixture for the 2D view (field-map) parity smoke.

A swept Prism6 film (three exact layers, four certificate node planes) with a
Pyramid5 transition shell and Tet4 air. It exercises FEM node-plane layer
stops, Hex/Pyramid-capable planar sampling, the cached plane operator and the
direction colormap on a vortex.

Run with:
    just docker-dev-script examples/viewport_2d_fem_mixed_smoke.py
"""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9

fm.reset()
study = fm.study("viewport_2d_fem_mixed_smoke")
study.mode("strict")
study.engine("fem")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "cpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)

study.universe(
    mode="manual",
    size=(200 * NM, 200 * NM, 80 * NM),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=20 * NM,
    minimum_element_size=4 * NM,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(fm.Box(size=(120 * NM, 120 * NM, 9 * NM), name="film"), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.5
film.m = fm.texture.vortex()
film.mesh.thin_film(
    maximum_element_size=5 * NM,
    layers=3,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)

study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.solver(dt=1e-14, integrator="heun", g=2.115)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-14, tolA=1e-3, max_steps=50)
