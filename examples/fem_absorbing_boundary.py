"""FEM strip with two object-owned Gilbert damping ramps and outer plateaus."""

import fullmag as fm

# %% Mesh and material
study = fm.study("fem_absorbing_boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

film = study.geometry(fm.Box(320e-9, 40e-9, 10e-9), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(maximum_element_size=10e-9, order=1)

# %% The 40 nm ramp leaves 20 nm of constant damping at either end.
film.alpha.absorbing_boundary(
    total_width=60e-9,
    ramp_width=40e-9,
    max_damping=0.5,
    faces=("x+", "x-"),
    profile="custom",
    expression="sqrt(u)",
    frame="object",
)

# %% Short exchange-only run with a transverse bias field
study.exchange()
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 0.02)
study.stages.add_run(stage_id="run", until=1e-12)
