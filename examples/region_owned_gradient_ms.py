"""Region-owned Ms gradient on one physical object.

The center window is an authored region that scopes a material field. It is not
a second magnetic object and it does not create an inter-object exchange
coupling.
"""

import fullmag as fm


study = fm.study("region_owned_gradient_ms")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(300e-9, 180e-9, 120e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=5e-9, maximum_element_size=80e-9)

track = study.geometry(
    fm.Box(size=(200e-9, 80e-9, 5e-9), name="permalloy_track"),
    name="permalloy_track",
)
track.Ms = 800e3
track.Aex = 13e-12
track.alpha = 0.02
track.m = fm.texture.uniform(1.0, 0.0, 0.0)

gradient_window = track.add_region(
    "gradient_window",
    fm.Box(size=(120e-9, 50e-9, 5e-9)),
    priority=10,
)
track.set_material_field(
    "Ms",
    fm.fields.linear(
        base=760e3,
        gradient=(0.0, 1.5e11, 0.0),
        unit="A/m",
    ),
    region=gradient_window,
    assignment_id="permalloy_track_gradient_window_ms",
    priority=10,
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
