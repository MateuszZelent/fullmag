"""Managed FDM fixture for the production planar-monitor browser/science smoke."""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
SIZE = (80 * NM, 60 * NM, 20 * NM)

study = fm.study("viewport_2d_planar_monitor_fdm_smoke")
study.engine("fdm")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "cpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(5 * NM, 5 * NM, 5 * NM)

film = study.geometry(fm.Box(size=SIZE, name="planar_film"), name="planar_film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.set_material_field(
    "Ms",
    fm.fields.linear(base=800e3, gradient=(1e12, 0.0, 0.0), unit="A/m"),
    assignment_id="planar_linear_ms",
)

target = fm.MonitorTarget.object("planar_film")
extent = fm.PlanarExtent.target_bounds()
study.monitors.add_planar(
    name="XY plane",
    monitor_id="xy-plane",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.PlaneSample(),
)
study.monitors.add_planar(
    name="XY slab",
    monitor_id="xy-slab",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.SlabAverage(thickness=10 * NM),
)
study.monitors.add_planar(
    name="Depth mean",
    monitor_id="depth-mean",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.DepthProjection(reduction="mean_occupied"),
)
study.monitors.add_planar(
    name="Oblique plane",
    monitor_id="oblique-plane",
    target=target,
    frame=fm.PlanarFrame(
        origin=(0.0, 0.0, 0.0),
        normal=(1.0, 1.0, 1.0),
        u_axis=(1.0, -1.0, 0.0),
        extent=fm.PlanarExtent.explicit(u=(-45 * NM, 45 * NM), v=(-45 * NM, 45 * NM)),
    ),
    operator=fm.PlaneSample(),
)

study.exchange()
study.solver(dt=1e-15, integrator="heun", g=2.115)
study.save("m", every=1e-15)
study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-15,
    tol=1e-3,
    max_steps=1,
)
