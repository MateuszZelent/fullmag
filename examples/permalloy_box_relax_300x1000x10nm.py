"""Permalloy 300 nm x 1000 nm x 10 nm box relaxation.

The initial magnetization is uniform along the long y axis and no external
field is applied.
"""

import fullmag as fm


study = fm.study("permalloy_box_relax_300x1000x10nm")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="auto",
    size=(1700e-9, 2.4e-6, 260e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=10e-9, maximum_element_size=250e-9)
study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff", wireframe=False)

hole_radius = 40e-9
hole_height = 30e-9
hole_refinement_radius = hole_radius + 30e-9

body = study.geometry(
    fm.Box(300e-9, 1000e-9, 30e-9) - fm.Cylinder(radius=hole_radius, height=hole_height),
    name="permalloy_box"
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
# body.dind=9.0
# body.temp=200
body.m = fm.texture.uniform(0.1, 1.0, 0.0)
body.mesh(minimum_element_size=8e-9, maximum_element_size=50e-9, order=1)
hole_refinement = body.add_region(
    "hole_refinement",
    fm.Cylinder(radius=hole_refinement_radius, height=hole_height),
    priority=10,
    realization_policy="conformal",
)
hole_refinement.mesh(minimum_element_size=0.5e-9, maximum_element_size=1e-9, order=1)
# hole_refinement.material.Ms = 1e3

study.demag(realization="poisson_robin")
study.build_domain_mesh()

study.minimize(
    method="bb",
    max_steps=1000,
    tol=1e-30,
)
study.tableautosave(1e-13, quantities=["time", "step", "mx", "my", "mz", "E_total"])
study.relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_error=1e-6,
    dt_min=1e-17,
    max_steps=350,
    tol=1e-4,
)
