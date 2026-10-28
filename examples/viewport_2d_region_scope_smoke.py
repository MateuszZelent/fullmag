"""Two-region FDM fixture for the 2D view region scope (gate PM-N24).

One film owns two regions: `outer` covers the whole film with m = +x and
`core`, a centred 56 nm wide strip with higher priority, has m = -x. With the
2D view scoped to `core`, the map shows m_x = -1 on the strip only; scoped to
`outer`, it shows m_x = +1 around it. The study waits for Compute, so the
initial state is what the view samples.

Both regions are centred on the object on purpose: region shapes moved with
`translate` are currently realized at the object centre on FDM (see the 2D
status ledger), so a left/right split cannot be used here yet.

Run with:
    just docker-dev-script examples/viewport_2d_region_scope_smoke.py
"""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
CELL = 4 * NM
SIZE = (32 * CELL, 20 * CELL, 2 * CELL)

fm.reset()
study = fm.study("viewport_2d_region_scope_smoke")
study.engine("fdm")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "cpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)

film = study.geometry(fm.Box(size=(120 * NM, 80 * NM, SIZE[2]), name="film"), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.5
film.m = fm.init.UniformMagnetization((0.0, 1.0, 0.0))

outer = film.add_region(
    "outer",
    fm.Box(size=(120 * NM, 80 * NM, SIZE[2]), name="outer"),
    priority=10,
)
outer.texture = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
core = film.add_region(
    "core",
    fm.Box(size=(56 * NM, 80 * NM, SIZE[2]), name="core"),
    priority=20,
)
core.texture = fm.init.UniformMagnetization((-1.0, 0.0, 0.0))

study.demag()
study.solver(dt=1e-13, integrator="heun", g=2.115)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolA=1e-3, max_steps=20)
