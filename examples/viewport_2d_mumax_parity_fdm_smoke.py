"""FDM fixture for the 2D field-map parity gate (MuMax3 fork reference).

The grid (128 x 128 x 2 = 32768 cells) exceeds the default display preview
budget of 16384 points, so a 2D view of a quantity other than the 3D one must
be served by full-resolution observation fields rather than the display frame.
"""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
CELL = 4 * NM
SIZE = (128 * CELL, 128 * CELL, 2 * CELL)

study = fm.study("viewport_2d_mumax_parity_fdm_smoke")
study.engine("fdm")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "cpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)

disk = study.geometry(
    fm.Cylinder(radius=200 * NM, height=SIZE[2] - 1e-6 * NM, name="disk"), name="disk"
)
disk.Ms = 800e3
disk.Aex = 13e-12
disk.alpha = 0.5
disk.m = fm.texture.vortex()

study.demag()
study.solver(dt=1e-13, integrator="heun", g=2.115)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolA=1e-3, max_steps=200)
