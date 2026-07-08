"""FEM k=0 Kittel self-verification fixture with synthetic thin-film demag.

This is the PA-E4a gate for K0-3: it validates branch tracking and artifacts
against the ideal in-plane thin-film Kittel formula using M_eff = Ms. It does
not claim real Poisson-airbox demag; that starts with the later small FEM
film/shared-airbox gate.

Usage:
    FULLMAG_FEM_EXECUTION=cpu fullmag examples/fem_eigen_k0_kittel_thinfilm_demag.py --headless
"""

import math

import fullmag as fm


MU0 = 4.0e-7 * math.pi
MS = 800e3
BIAS_FIELDS_T = (0.02, 0.05, 0.10, 0.20, 0.40)
BIAS_FIELDS_A_PER_M = tuple(field_t / MU0 for field_t in BIAS_FIELDS_T)
N_MODES = 1
FREQUENCY_MAX_HZ = 25.0e9


study = fm.study("fem_eigen_k0_kittel_thinfilm_demag")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(40e-9, 40e-9, 40e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=40e-9)

body = study.geometry(fm.Box(size=(40e-9, 20e-9, 10e-9), name="body"), name="body")
body.Ms = MS
body.Aex = 13e-12
body.alpha = 0.0
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=40e-9, order=1)

study.pbc(x=True)
study.build_domain_mesh()
study.b_ext(BIAS_FIELDS_T[0], 0.0, 0.0)

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=(0,))

study.k0_kittel_validation(
    fm.K0KittelFieldSweepValidation(
        case_id="K0-3",
        demag_kind="synthetic_demag_factor",
        model="thin_film_in_plane",
        effective_magnetisation=MS,
        relative_tolerance=0.02,
        samples=[
            fm.K0KittelFieldSample(sample_index, (field_a_per_m, 0.0, 0.0))
            for sample_index, field_a_per_m in enumerate(BIAS_FIELDS_A_PER_M)
        ],
    )
)

study.stages.add_eigenmodes(
    count=N_MODES,
    target="frequency_window",
    frequency_min=100e6,
    frequency_max=FREQUENCY_MAX_HZ,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("H20mT", (0.0, 0.0, 0.0)),
            fm.KPoint("H400mT", (0.0, 0.0, 0.0)),
        ],
        samples_per_segment=[len(BIAS_FIELDS_A_PER_M) - 1],
    ),
    bc=fm.FloquetBC(["x_faces"]),
)
