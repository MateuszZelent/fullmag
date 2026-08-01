"""Managed FEM fixture for the production planar-monitor browser/science smoke."""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
SIZE = (80 * NM, 60 * NM, 20 * NM)

study = fm.study("viewport_2d_planar_monitor_fem_smoke")
study.engine("fem")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "gpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="auto", size=(140 * NM, 120 * NM, 80 * NM), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(minimum_element_size=5 * NM, maximum_element_size=40 * NM)

film = study.geometry(fm.Box(size=SIZE, name="planar_film"), name="planar_film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(minimum_element_size=5 * NM, maximum_element_size=20 * NM, order=1)
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
    name="Object surface",
    monitor_id="object-surface",
    target=target,
    frame=fm.PlanarFrame.xy(position=0.0, extent=extent),
    operator=fm.SurfaceProjection(
        boundary=fm.SurfaceBoundary.object_boundary(),
        visibility_policy="frontmost",
    ),
)

study.exchange()
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
