"""Inspect two independent strip terminations and a region-clipped circular absorber."""

import fullmag as fm

# %% Magnetic strip, 200 nm by 100 nm
nm = 1e-9
study = fm.study("spatial_absorbing_layers")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(fm.Box(200 * nm, 100 * nm, 8 * nm), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(maximum_element_size=3 * nm, order=1)

# %% Limit the circular band to y >= 0 in the film
upper_half = film.add_region(
    "Upper half",
    fm.Box(200 * nm, 50 * nm, 8 * nm).translate((0, 25 * nm, 0)),
    region_id="upper-half",
    realization_policy="project",
)

# %% Select Material alpha after building the mesh to see all three layers
film.alpha.absorbing_boundary(layers=[
    fm.SpatialAbsorbingLayer(
        layer_id="left", name="Left end",
        geometry=fm.AbsorbingGeometry.faces(("x-",)),
        total_width_m=25 * nm, ramp_width_m=20 * nm,
        max_damping=0.3, profile="linear",
    ),
    fm.SpatialAbsorbingLayer(
        layer_id="right", name="Right end",
        geometry=fm.AbsorbingGeometry.faces(("x+",)),
        total_width_m=40 * nm, ramp_width_m=24 * nm,
        max_damping=0.6, profile="quadratic",
    ),
    fm.SpatialAbsorbingLayer(
        layer_id="ring", name="Upper semicircle",
        region_id=upper_half.region_id,
        geometry=fm.AbsorbingGeometry.cylinder(
            center=(8 * nm, 0.0, 0.0), axis=(0.0, 0.0, 1.0), radius_m=35 * nm,
        ),
        total_width_m=15 * nm, ramp_width_m=12 * nm,
        max_damping=0.45, profile="custom", expression="u**3",
    ),
])

# %% Stage for interactive inspection before computing
study.exchange()
study.demag(enabled=False)
study.stages.add_run(stage_id="run", until=1e-12)
study.wait_for_solve(True)
