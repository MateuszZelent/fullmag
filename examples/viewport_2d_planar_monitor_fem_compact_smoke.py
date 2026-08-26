"""Compact one-object FEM fixture for planar-monitor browser evidence."""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
SIZE = (40 * NM, 30 * NM, 10 * NM)

study = fm.study("viewport_2d_planar_monitor_fem_compact_smoke")
study.engine("fem")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "gpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="auto", size=(80 * NM, 70 * NM, 50 * NM), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(minimum_element_size=5 * NM, maximum_element_size=25 * NM)

film = study.geometry(fm.Box(size=SIZE, name="compact_planar_film"), name="compact_planar_film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(minimum_element_size=5 * NM, maximum_element_size=15 * NM, order=1)

target = fm.MonitorTarget.object("compact_planar_film")
extent = fm.PlanarExtent.target_bounds()
study.monitors.add_planar(
    name="Compact FEM XY plane",
    monitor_id="xy-plane",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.PlaneSample(),
)
study.monitors.add_planar(
    name="Compact FEM XY slab",
    monitor_id="xy-slab",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.SlabAverage(thickness=5 * NM),
)
study.monitors.add_planar(
    name="Compact FEM surface",
    monitor_id="object-surface",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.SurfaceProjection(
        boundary=fm.SurfaceBoundary.object_boundary(),
        visibility_policy="frontmost",
    ),
)

study.build_domain_mesh()
study.solver(dt=1e-15, integrator="heun", g=2.115)
study.save("m", every=1e-15)
study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_error=1e-3,
    dt_min=1e-17,
    dt_max=1e-14,
    max_steps=1,
    tolA=1e-3,
)
