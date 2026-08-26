"""Managed FEM smoke for explicitly projected region-owned Ms/Aex fields."""

import fullmag as fm


study = fm.study("fem_region_owned_projected_fields_smoke")
study.engine("fem")
study.device("auto", precision="double")
study.mode("extended")
study.universe(
    mode="manual",
    size=(220e-9, 220e-9, 160e-9),
    center=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=50e-9)

film = study.geometry(
    fm.Box(size=(100e-9, 100e-9, 40e-9), name="film"),
    name="film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(maximum_element_size=25e-9, order=1)

core = film.add_region(
    "core",
    fm.Box(size=(40e-9, 40e-9, 20e-9)),
    region_id="film:core",
    priority=10,
    realization_policy="project",
)
core.material.Ms = fm.fields.constant(700e3, unit="A/m")
core.material.Aex = fm.fields.constant(8e-12, unit="J/m")
core.mesh(maximum_element_size=10e-9, order=1)

study.build_domain_mesh()
study.solver(dt=1e-13)
study.run(2e-13)
