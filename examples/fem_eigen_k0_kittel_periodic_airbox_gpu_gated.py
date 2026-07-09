"""FEM GPU k=0 Kittel periodic-airbox demag gated fixture.

This intentionally requests the unsupported GPU modal Poisson-airbox demag
path. The managed gate must fail clearly before any CPU fallback can be used.

Usage:
    FULLMAG_FEM_EXECUTION=gpu fullmag examples/fem_eigen_k0_kittel_periodic_airbox_gpu_gated.py --headless
"""

import math

import fullmag as fm


MU0 = 4.0e-7 * math.pi
MS = 800e3
BIAS_FIELDS_T = (1.0e-9, 0.05, 0.10)
BIAS_FIELDS_A_PER_M = tuple(field_t / MU0 for field_t in BIAS_FIELDS_T)


study = fm.study("fem_eigen_k0_kittel_periodic_airbox_gpu_gated")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(40e-9, 20e-9, 50e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=40e-9)
study.objects.mesh.defaults(periodic_pair_ids=["x_faces"])

body = study.geometry(fm.Box(size=(40e-9, 20e-9, 10e-9), name="body"), name="body")
body.Ms = MS
body.Aex = 13e-12
body.alpha = 0.0
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=40e-9, order=1)

study.pbc(x=True, demag="periodic_airbox_k0")
study.b_ext(BIAS_FIELDS_T[0], 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()

study.k0_kittel_validation(
    fm.K0KittelFieldSweepValidation(
        case_id="K0-3",
        demag_kind="periodic_airbox_k0",
        model="thin_film_in_plane",
        effective_magnetisation=MS,
        relative_tolerance=0.05,
        samples=[
            fm.K0KittelFieldSample(sample_index, (field_a_per_m, 0.0, 0.0))
            for sample_index, field_a_per_m in enumerate(BIAS_FIELDS_A_PER_M)
        ],
    )
)

study.stages.add_eigenmodes(
    count=1,
    target="frequency_window",
    frequency_min=1e3,
    frequency_max=25.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("Hnear0", (0.0, 0.0, 0.0)),
            fm.KPoint("H100mT", (0.0, 0.0, 0.0)),
        ],
        samples_per_segment=[len(BIAS_FIELDS_A_PER_M) - 1],
    ),
    bc=fm.PeriodicBC(["x_faces"]),
)
