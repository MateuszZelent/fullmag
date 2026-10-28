"""FEM CPU fixture for object-scoped quantity coloring in the 3D viewport.

The study waits for Compute so the browser can check prepared-state quantities
(torque, H_eff, energy densities, global energies) before the run, then again
after a short relaxation.

    just docker-dev-script examples/viewport_quantity_coloring_fem_cpu_smoke.py
"""

import os

import fullmag as fm


DEVICE = os.environ.get("FULLMAG_VIEWPORT_COLORING_DEVICE") or "cpu"

study = fm.study("viewport_quantity_coloring_fem_cpu_smoke")
study.engine("fem")
study.device(DEVICE, precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(
    mode="auto",
    size=(160e-9, 120e-9, 80e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=80e-9)

body = study.geometry(fm.Box(120e-9, 80e-9, 20e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.random(seed=7)
body.mesh(maximum_element_size=20e-9, order=1)

study.build_domain_mesh()
study.b_ext(0.0, 0.0, 0.02)
study.solver(dt=1e-13)

study.relax(
    algorithm="llg_overdamped",
    max_steps=20,
    tolA=1e-30,
    dt=1e-13,
)
