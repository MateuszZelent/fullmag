"""FEM fixture for the PM-N17 plane-operator scale gate (note 0970).

A uniform-texture film meshed at about 2 nm gives roughly 2e5 Tet4 elements,
so default sections exercise the element index of the plane operator. Only
the initial state is sampled; the relax stage waits for an explicit solve.
"""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
DOMAIN_SIZE = (80 * NM, 60 * NM, 40 * NM)
ELEMENT_SIZE = float(os.environ.get("FULLMAG_PM_N17_ELEMENT_NM", "2.2")) * NM

study = fm.study("viewport_2d_fem_large_mesh_smoke")
study.engine("fem")
study.device("cpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)
UNIVERSE_SIZE = (100 * NM, 80 * NM, 60 * NM)
study.universe(mode="manual", size=UNIVERSE_SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
# Air is only the mesher's required outer volume here; keep it coarse.
study.universe.mesh(minimum_element_size=0.7 * ELEMENT_SIZE, maximum_element_size=8 * NM)

film = study.geometry(fm.Box(size=DOMAIN_SIZE, name="large_mesh_film"), name="large_mesh_film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.5
film.m = fm.texture.vortex()
film.mesh(minimum_element_size=0.7 * ELEMENT_SIZE, maximum_element_size=ELEMENT_SIZE, order=1)

study.exchange()
study.build_domain_mesh()
study.solver(dt=1e-14, integrator="heun", g=2.115)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-14, tolA=1e-3, max_steps=1)
