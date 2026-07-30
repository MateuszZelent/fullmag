"""Short runtime probe for a permalloy mesh-only object region."""

import fullmag as fm


study = fm.study("permalloy_hole_mesh_only_relax_probe")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="auto",
    size=(700e-9, 1.4e-6, 220e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=20e-9, maximum_element_size=180e-9)

hole_radius = 30e-9
hole_height = 30e-9

body = study.geometry(
    fm.Box(300e-9, 1000e-9, 30e-9)
    - fm.Cylinder(radius=hole_radius, height=hole_height),
    name="permalloy_box",
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.uniform(0.0, 1.0, 0.0)
body.mesh(minimum_element_size=8e-9, maximum_element_size=50e-9, order=1)

hole_refinement = body.add_region(
    "hole_refinement",
    fm.Cylinder(radius=hole_radius + 30e-9, height=hole_height),
    priority=10,
)
hole_refinement.mesh(
    minimum_element_size=4e-9,
    maximum_element_size=8e-9,
    transition_distance=40e-9,
    order=1,
)

study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_error=1e-6,
    dt_min=1e-17,
    max_steps=1,
    tolA=1e-4,
)
