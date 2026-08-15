"""Managed FEM fixture for the production planar-monitor browser/science smoke."""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
SIZE = (80 * NM, 60 * NM, 20 * NM)
QUALIFICATION_PROFILE = os.environ.get("FULLMAG_PLANAR_QUALIFICATION_PROFILE", "base")

study = fm.study("viewport_2d_planar_monitor_fem_smoke")
study.engine("fem")
study.device(os.environ.get("FULLMAG_PLANAR_DEVICE", "gpu"), precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(mode="auto", size=(140 * NM, 120 * NM, 80 * NM), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
mesh_scale = 0.5 if QUALIFICATION_PROFILE == "mesh-refined" else 1.0
study.universe.mesh(
    minimum_element_size=5 * NM * mesh_scale,
    maximum_element_size=40 * NM * mesh_scale,
)

film = study.geometry(fm.Box(size=SIZE, name="planar_film"), name="planar_film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(
    minimum_element_size=5 * NM * mesh_scale,
    maximum_element_size=20 * NM * mesh_scale,
    order=1,
)
film.set_material_field(
    "Ms",
    fm.fields.linear(base=800e3, gradient=(1e12, 0.0, 2e12), unit="A/m"),
    assignment_id="planar_linear_ms",
)
qualification_core = film.add_region(
    "Qualification core",
    fm.Box(size=(40 * NM, 30 * NM, 20 * NM)),
    region_id="qualification_core",
    priority=10,
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
    frame=fm.PlanarFrame.xy(position=5 * NM, extent=extent),
    operator=fm.SlabAverage(thickness=30 * NM),
)
study.monitors.add_planar(
    name="XZ plane",
    monitor_id="xz-plane",
    target=target,
    frame=fm.PlanarFrame.xz(position=0.0, extent=extent),
    operator=fm.PlaneSample(),
)
study.monitors.add_planar(
    name="YZ plane",
    monitor_id="yz-plane",
    target=target,
    frame=fm.PlanarFrame.yz(position=0.0, extent=extent),
    operator=fm.PlaneSample(),
)
study.monitors.add_planar(
    name="Region plane",
    monitor_id="region-plane",
    target=fm.MonitorTarget.region("planar_film", qualification_core.region_id),
    frame=fm.PlanarFrame.xy(position=0.0, extent=fm.PlanarExtent.target_bounds()),
    operator=fm.PlaneSample(),
)
study.monitors.add_planar(
    name="Magnetic domain plane",
    monitor_id="magnetic-plane",
    target=fm.MonitorTarget.magnetic_domain(),
    frame=fm.PlanarFrame.xy(position=0.0, extent=fm.PlanarExtent.magnetic_domain()),
    operator=fm.PlaneSample(),
)
study.monitors.add_planar(
    name="Domain plane",
    monitor_id="domain-plane",
    target=fm.MonitorTarget.domain(),
    frame=fm.PlanarFrame.xy(position=0.0, extent=fm.PlanarExtent.universe()),
    operator=fm.PlaneSample(),
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
study.demag(realization="poisson_robin")
study.build_domain_mesh()
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
