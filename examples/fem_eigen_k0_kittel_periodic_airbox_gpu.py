"""Production GPU FEM k=0 Kittel field sweep with periodic-airbox demag.

This is the GPU peer of ``fem_eigen_k0_kittel_periodic_airbox.py``.  It uses
the same physical signature and requests strict double-precision GPU
execution so CPU/GPU parity compares the solver realizations, not two
different studies.

Usage:
    FULLMAG_FEM_EXECUTION=gpu fullmag examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py --headless
"""

import math
import os

import fullmag as fm


MU0 = 4.0e-7 * math.pi
MS = 800e3
MAG_HMAX_M = float(os.environ.get("FULLMAG_K0_KITTEL_MAG_HMAX_NM", "20.0")) * 1e-9
MAG_HMIN_M = float(os.environ.get("FULLMAG_K0_KITTEL_MAG_HMIN_NM", "10.0")) * 1e-9
AIRBOX_HMAX_M = float(os.environ.get("FULLMAG_K0_KITTEL_AIRBOX_HMAX_NM", "40.0")) * 1e-9
AIRBOX_FACTOR = float(os.environ.get("FULLMAG_K0_KITTEL_AIRBOX_FACTOR", "5.0"))
BODY_X_M = float(os.environ.get("FULLMAG_K0_KITTEL_BODY_X_NM", "40.0")) * 1e-9
BODY_Y_M = float(os.environ.get("FULLMAG_K0_KITTEL_BODY_Y_NM", "20.0")) * 1e-9
BODY_Z_M = float(os.environ.get("FULLMAG_K0_KITTEL_BODY_Z_NM", "10.0")) * 1e-9
BIAS_FIELD_MIN_T = 5.0e-3
BIAS_FIELD_MAX_T = 0.10
BIAS_FIELDS_T = tuple(
    BIAS_FIELD_MIN_T
    + (BIAS_FIELD_MAX_T - BIAS_FIELD_MIN_T) * sample_index / 14.0
    for sample_index in range(15)
)
BIAS_FIELDS_A_PER_M = tuple(field_t / MU0 for field_t in BIAS_FIELDS_T)
N_MODES = 1
FREQUENCY_MAX_HZ = 25.0e9


study = fm.study("fem_eigen_k0_kittel_periodic_airbox")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(BODY_X_M, BODY_Y_M, AIRBOX_FACTOR * BODY_Z_M),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=MAG_HMAX_M,
    maximum_element_size=AIRBOX_HMAX_M,
    growth_rate=1.5,
    grading="linear",
)
study.objects.mesh.defaults(
    periodic_pair_ids=["x_faces", "y_faces"],
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=4,
    narrow_regions=1,
)

body = study.geometry(fm.Box(size=(BODY_X_M, BODY_Y_M, BODY_Z_M), name="body"), name="body")
body.Ms = MS
body.Aex = 13e-12
body.alpha = 0.0
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=MAG_HMIN_M,
    maximum_element_size=MAG_HMAX_M,
    interface_maximum_element_size=MAG_HMAX_M,
    edge_thickness=2e-9,
    edge_transition_distance=4e-9,
    corner_extent=2e-9,
    corner_transition_distance=4e-9,
    layers=1,
    order=1,
)

study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.b_ext(BIAS_FIELDS_T[0], 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
# Keep the iterative solve tighter than the independent 1e-8 residual gate;
# otherwise a backend stopping at its own 1e-8 estimate can miss the
# independently recomputed threshold by roundoff on refined meshes.
study.fem_demag_solver(rtol=1e-10, max_iterations=1000)
study.build_domain_mesh()

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=(0,))

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

study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-15,
    max_steps=8,
    tolA=1e-3,
    relax_alpha=1.0,
)
study.stages.add_eigenmodes(
    count=N_MODES,
    target="nearest",
    target_frequency=2.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    # The K0-3 validation is a real zero-k field sweep: the path keeps the
    # physical wavevector at Gamma while the runner applies each declared
    # bias-field sample to the native modal solve.
    k_sampling=fm.KPath(
        [
            fm.KPoint("Hnear0", (0.0, 0.0, 0.0)),
            fm.KPoint("H100mT", (0.0, 0.0, 0.0)),
        ],
        samples_per_segment=[14],
    ),
    bc=fm.PeriodicBC(["x_faces", "y_faces"]),
)
