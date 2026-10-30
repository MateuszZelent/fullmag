"""FDM vortex disk inscribed in its grid, for the 3D Airbox visualization.

The disk diameter equals the grid side (24 x 24 x 1 cells of 5 nm), so the
bounding box of the magnetic cells equals the grid bounding box while the four
corners hold inactive cells. Universe > Airbox > Visualization with H_demag
(or H_eff) must draw points and vectors in those corner cells.

Run with:
    just docker-dev-script examples/viewport_airbox_fdm_inscribed_disk_smoke.py
"""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
CELL = 5 * NM
SIZE = (24 * CELL, 24 * CELL, CELL)

fm.reset()
study = fm.study("viewport_airbox_fdm_inscribed_disk_smoke")
study.engine("fdm")
study.device(os.environ.get("FULLMAG_AIRBOX_DEVICE", "cpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)

disk = study.geometry(fm.Cylinder(radius=SIZE[0] / 2, height=SIZE[2], name="disk"), name="disk")
disk.Ms = 800e3
disk.Aex = 13e-12
disk.alpha = 0.5
disk.m = fm.texture.vortex()

study.demag()
study.solver(dt=1e-13, integrator="heun", g=2.115)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolA=1e-3, max_steps=200)
