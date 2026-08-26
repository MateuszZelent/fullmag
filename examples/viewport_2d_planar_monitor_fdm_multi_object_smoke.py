"""Compact multi-object FDM fixture for planar-monitor browser evidence."""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
OBJECT_SIZE = (40 * NM, 40 * NM, 10 * NM)
UNIVERSE_SIZE = (120 * NM, 60 * NM, 20 * NM)

study = fm.study("viewport_2d_planar_monitor_fdm_multi_object_smoke")
study.engine("fdm")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "cpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="manual", size=UNIVERSE_SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(5 * NM, 5 * NM, 5 * NM)


def add_film(name: str, center_x: float, magnetization: tuple[float, float, float]) -> None:
    film = study.geometry(
        fm.Box(size=OBJECT_SIZE, name=name).translate((center_x, 0.0, 0.0)),
        name=name,
    )
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.1
    film.m = fm.texture.uniform(*magnetization)


add_film("planar_left", -30 * NM, (1.0, 0.0, 0.0))
add_film("planar_right", 30 * NM, (0.0, 1.0, 0.0))

target = fm.MonitorTarget.magnetic_domain()
extent = fm.PlanarExtent.magnetic_domain()
study.monitors.add_planar(
    name="Multi-object XY plane",
    monitor_id="xy-plane",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.PlaneSample(),
)
study.monitors.add_planar(
    name="Multi-object XY slab",
    monitor_id="xy-slab",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.SlabAverage(thickness=10 * NM),
)
study.monitors.add_planar(
    name="Multi-object depth mean",
    monitor_id="depth-mean",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.DepthProjection(reduction="mean_occupied"),
)
study.monitors.add_planar(
    name="Multi-object oblique plane",
    monitor_id="oblique-plane",
    target=target,
    frame=fm.PlanarFrame(
        origin=(0.0, 0.0, 0.0),
        normal=(1.0, 1.0, 1.0),
        u_axis=(1.0, -1.0, 0.0),
        extent=fm.PlanarExtent.explicit(u=(-70 * NM, 70 * NM), v=(-50 * NM, 50 * NM)),
    ),
    operator=fm.PlaneSample(),
)

study.solver(dt=1e-15, integrator="heun", g=2.115)
study.save("m", every=1e-15)
study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-15,
    tolA=1e-3,
    max_steps=1,
)
