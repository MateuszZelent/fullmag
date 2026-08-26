"""Skyrmion-core mesh refinement with one physical film object.

The cylindrical core region only scopes the local mesh policy. The parent film
keeps its bulk 10 nm mesh policy outside the core.
"""

import fullmag as fm


study = fm.study("skyrmion_core_mesh_refinement")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(300e-9, 180e-9, 120e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=1e-9, maximum_element_size=80e-9)

track = study.geometry(
    fm.Box(size=(200e-9, 80e-9, 2e-9), name="permalloy_track"),
    name="permalloy_track",
)
track.Ms = 800e3
track.Aex = 13e-12
track.alpha = 0.02
track.m = fm.texture.neel_skyrmion(
    radius=30e-9,
    wall_width=5e-9,
    chirality=1,
    core_polarity=-1,
)
track.mesh(minimum_element_size=5e-9, maximum_element_size=10e-9, order=1)

core = track.add_region(
    "skyrmion_core",
    fm.Cylinder(radius=30e-9, height=2e-9),
    priority=10,
)
core.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=1e-9,
    transition_distance=40e-9,
    order=1,
)

study.demag(realization="poisson_robin")
study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_error=1e-6,
    dt_min=1e-17,
    dt_max=1e-14,
    max_steps=200,
    tolA=1e-4,
)
