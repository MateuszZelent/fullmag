"""Target FEM DE/BV low-k modal dispersion input.

This script declares the production-facing Damon-Eshbach and backward-volume
validation shape for thin-film spin-wave dispersion:

- in-plane equilibrium magnetization along +x,
- BV samples with k parallel to m0,
- DE samples with k perpendicular to m0,
- |k| <= 3e6 rad/m,
- modal window up to 5 GHz,
- analytic Kalinikos slab n=0 comparison intent.

It intentionally requests dynamic demag with nonzero-k Floquet conditions.
That operator is still M10 work, so this script is a canonical target input and
validation fixture, not a currently passing managed runtime gate.
"""

import fullmag as fm


study = fm.study("fem_eigenmodes_dispersion_de_bv_low_k")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(80e-9, 80e-9, 40e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=40e-9)

film = study.geometry(fm.Box(size=(80e-9, 80e-9, 20e-9), name="film"), name="film")
film.Ms = 140e3
film.Aex = 3.5e-12
film.alpha = 0.001
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh(maximum_element_size=40e-9, order=1)

study.pbc(x=True, y=True)
study.build_domain_mesh()
study.b_ext(0.05, 0.0, 0.0)

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=(0,))

study.dispersion_validation(
    fm.ThinFilmDEBVDispersionValidation(
        film_thickness_m=20e-9,
        equilibrium_magnetization=(1.0, 0.0, 0.0),
        film_normal=(0.0, 0.0, 1.0),
        frequency_window_hz=(0.0, 5.0e9),
        max_k_rad_per_m=3.0e6,
        max_relative_error=0.10,
        scenarios=[
            fm.DispersionValidationScenario("backward_volume", "branch_0", [0, 1, 2]),
            fm.DispersionValidationScenario("damon_eshbach", "branch_0", [3, 4, 5]),
        ],
    )
)

study.stages.add_eigenmodes(
    count=1,
    target="frequency_window",
    frequency_min=1.0e6,
    frequency_max=5.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("G", (0.0, 0.0, 0.0)),
            fm.KPoint("BV", (3.0e6, 0.0, 0.0)),
            fm.KPoint("G", (0.0, 0.0, 0.0)),
            fm.KPoint("DE", (0.0, 3.0e6, 0.0)),
        ],
        samples_per_segment=[2, 1, 2],
    ),
    bc=fm.FloquetBC(["x_faces", "y_faces"]),
)
