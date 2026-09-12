"""Production-scope FEM k=0 modal solve with shared periodic airbox demag.

This fixture intentionally contains no analytical Kittel metadata.  It is the
fresh runtime artifact used by the production-scope recipes; independent
physics, convergence, parity, and DOD evidence is bound afterwards.

Usage:
    FULLMAG_K0_PRODUCTION_DEVICE=cpu fullmag examples/fem_eigen_k0_poisson_airbox_production.py --headless
"""

import math
import os

import fullmag as fm


MU0 = 4.0e-7 * math.pi
MS = 800e3
DEVICE = os.environ.get("FULLMAG_K0_PRODUCTION_DEVICE", "cpu")
if DEVICE not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_K0_PRODUCTION_DEVICE must be 'cpu' or 'gpu'")

MAG_HMAX_M = float(os.environ.get("FULLMAG_K0_PRODUCTION_MAG_HMAX_NM", "20.0")) * 1e-9
MAG_HMIN_M = float(os.environ.get("FULLMAG_K0_PRODUCTION_MAG_HMIN_NM", "10.0")) * 1e-9
AIRBOX_HMAX_M = float(os.environ.get("FULLMAG_K0_PRODUCTION_AIRBOX_HMAX_NM", "40.0")) * 1e-9
AIRBOX_FACTOR = float(os.environ.get("FULLMAG_K0_PRODUCTION_AIRBOX_FACTOR", "5.0"))
BODY_X_M = float(os.environ.get("FULLMAG_K0_PRODUCTION_BODY_X_NM", "40.0")) * 1e-9
BODY_Y_M = float(os.environ.get("FULLMAG_K0_PRODUCTION_BODY_Y_NM", "20.0")) * 1e-9
BODY_Z_M = float(os.environ.get("FULLMAG_K0_PRODUCTION_BODY_Z_NM", "10.0")) * 1e-9
BIAS_FIELD_T = float(os.environ.get("FULLMAG_K0_PRODUCTION_BIAS_FIELD_T", "0.05"))


study = fm.study("fem_eigen_k0_poisson_airbox_production")
study.engine("fem")
study.device(DEVICE, precision="double")
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
study.b_ext(BIAS_FIELD_T, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(rtol=1e-10, max_iterations=1000)
study.build_domain_mesh()

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=(0,))

study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-15,
    max_steps=8,
    tolA=1e-3,
    relax_alpha=1.0,
)
def add_modal_stage() -> None:
    study.stages.add_eigenmodes(
        count=1,
        target="nearest",
        target_frequency=2.0e9,
        operator="full_2x2",
        include_demag=True,
        equilibrium_source="relax",
        normalization="unit_l2",
        damping_policy="ignore",
        k_vector=(0.0, 0.0, 0.0),
        bc=fm.PeriodicBC(["x_faces", "y_faces"]),
        magnetostatic_bc="periodic_airbox_k0",
    )


add_modal_stage()
# The performance gate executes a second identical stage in the same native
# process to prove exact operator-context reuse.  Normal production runs keep
# the fixture to one modal stage.
if os.environ.get("FULLMAG_K0_PERFORMANCE_REPEAT") == "1":
    add_modal_stage()
