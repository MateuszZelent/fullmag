"""Permalloy 300 nm x 1000 nm x 10 nm box relaxation.

The initial magnetization is uniform along the long y axis and no external
field is applied.
"""

import fullmag as fm


study = fm.study("permalloy_box_relax_300x1000x10nm")
study.engine("fem")
study.device("auto", precision="double")
study.universe(
    mode="auto",
    size=(700e-9, 1.4e-6, 160e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=10e-9, maximum_element_size=150e-9)
study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff", wireframe=False)

body = study.geometry(fm.Box(300e-9, 1000e-9, 10e-9), name="permalloy_box")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.uniform(0.0, 1.0, 0.0)
body.mesh(minimum_element_size=10e-9, maximum_element_size=50e-9, order=1)

study.demag(realization="poisson_robin")
study.build_domain_mesh()

study.minimize(
    method="bb",
    max_steps=100,
    tol=1e-30,
)

study.relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_error=1e-6,
    dt_min=1e-17,
    max_steps=350,
    tol=1e-4,
)
