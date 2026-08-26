"""Managed FDM fixture for the session-resolved Default planar-source gate."""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
DOMAIN_SIZE = (80 * NM, 60 * NM, 40 * NM)
DOMAIN_CENTER = (12.5 * NM, -7.5 * NM, 3.0 * NM)
CELL_SIZE = 5 * NM
GEOMETRY_INSET = 1e-6 * NM
GEOMETRY_SIZE = (
    DOMAIN_SIZE[0] - 2 * GEOMETRY_INSET,
    DOMAIN_SIZE[1] - 2 * GEOMETRY_INSET,
    DOMAIN_SIZE[2] - 2 * GEOMETRY_INSET,
)

study = fm.study("viewport_2d_default_slice_fdm_smoke")
study.engine("fdm")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "cpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(
    mode="manual",
    size=DOMAIN_SIZE,
    center=DOMAIN_CENTER,
    padding=(0.0, 0.0, 0.0),
)
study.cell(CELL_SIZE, CELL_SIZE, CELL_SIZE)

film = study.geometry(
    fm.Box(size=GEOMETRY_SIZE, name="default_domain_film").translate(DOMAIN_CENTER),
    name="default_domain_film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.demag()
study.solver(dt=1e-15, integrator="heun", g=2.115)
study.save("m", every=1e-15)
study.stages.add_hysteresis_sweep(
    field_values_mT=[0.0],
    orientation=fm.FieldOrientation.preset("in_plane_x"),
    measurement_axis="field_axis",
    initial_protocol="as_authored",
    branch_mode="major_loop",
    settle_pipeline=fm.SettlePipeline([
        fm.RelaxStep(
            method="llg_overdamped",
            alpha=1.0,
            torque_tolerance=1e-3,
            max_steps=1,
            on_non_convergence="continue_with_warning",
        )
    ]),
    storage=fm.HysteresisStorage(
        scalar_history=True,
        magnetization="every_n",
        every_n=1,
        key_events=False,
    ),
)
