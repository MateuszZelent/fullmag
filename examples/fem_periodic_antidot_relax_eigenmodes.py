"""Relax a periodic Permalloy antidot and compute its K0 eigenmodes.

The unit cell is periodic in x/y and open in z. Dynamic demagnetization uses
the same periodic Poisson-airbox domain as the relaxed equilibrium.

Run with:
    fullmag --dev -i examples/fem_periodic_antidot_relax_eigenmodes.py
"""

import math
import os

import fullmag as fm


device = os.environ.get("FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE", "cpu")
if device not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE must be 'cpu' or 'gpu'")

mode_count_raw = os.environ.get("FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT", "8")
save_mode_count_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT", "4"
)
try:
    mode_count = int(mode_count_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT must be an integer, "
        f"got {mode_count_raw!r}"
    ) from exc
try:
    save_mode_count = int(save_mode_count_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT must be an integer, "
        f"got {save_mode_count_raw!r}"
    ) from exc
if mode_count <= 0:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT must be positive, "
        f"got {mode_count}"
    )
if save_mode_count <= 0:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT must be positive, "
        f"got {save_mode_count}"
    )
if save_mode_count > mode_count:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT must not exceed "
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT"
    )

frequency_min_ghz_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ", "0.5"
)
frequency_max_ghz_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ", "30.0"
)
try:
    frequency_min_ghz = float(frequency_min_ghz_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ must be a number, "
        f"got {frequency_min_ghz_raw!r}"
    ) from exc
try:
    frequency_max_ghz = float(frequency_max_ghz_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ must be a number, "
        f"got {frequency_max_ghz_raw!r}"
    ) from exc
if not math.isfinite(frequency_min_ghz):
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ must be finite, "
        f"got {frequency_min_ghz_raw!r}"
    )
if not math.isfinite(frequency_max_ghz):
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ must be finite, "
        f"got {frequency_max_ghz_raw!r}"
    )
frequency_min_hz = frequency_min_ghz * 1.0e9
frequency_max_hz = frequency_max_ghz * 1.0e9
if frequency_min_hz < 0.0:
    raise ValueError("FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ must be non-negative")
if frequency_max_hz <= frequency_min_hz:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ must be greater than "
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ"
    )

mu0_t_m_per_a = 4.0e-7 * math.pi
equilibrium_torque_tolerance_t = 5.0e-3
equilibrium_torque_tolerance_a_per_m = (
    equilibrium_torque_tolerance_t / mu0_t_m_per_a
)

study = fm.study("fem_periodic_antidot_relax_eigenmodes")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(200e-9, 200e-9, 400e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5e-9,
    maximum_element_size=100e-9,
    growth_rate=1.5,
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.interactive(False)

film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="periodic_antidot_base")
hole = fm.Cylinder(radius=25e-9, height=10e-9, name="central_hole")
body = study.geometry(film - hole, name="periodic_antidot_film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=10e-9,
    maximum_element_size=20e-9,
    curvature_factor=0.25,
    narrow_region_resolution=1.5,
    layers=1,
    order=1,
)

hole_transition = body.add_region(
    "hole_transition_refinement",
    fm.Cylinder(radius=43e-9, height=10e-9, name="hole_transition_refinement"),
    priority=10,
    realization_policy="conformal",
)
hole_transition.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=20e-9,
    transition_distance=20e-9,
    order=1,
)

study.runtime_metadata(
    "periodic_antidot_eigensolve",
    {
        "scenario": "relax_then_eigenmodes_k0",
        "exchange_coupled_across_periods": True,
        "magnetostatic_pbc": "periodic_airbox_k0",
        "periodic_pair_ids": ["x_faces", "y_faces"],
        "open_axis": "z",
        "film_size_m": [200e-9, 200e-9, 10e-9],
        "universe_size_m": [200e-9, 200e-9, 400e-9],
        "hole_radius_m": 25e-9,
        "bias_field_t": [10e-3, 0.0, 0.0],
        "requested_modal_device": device,
        "frequency_window_hz": [frequency_min_hz, frequency_max_hz],
        "mode_count": mode_count,
        "saved_mode_indices": list(range(save_mode_count)),
        "equilibrium_torque_tolerance_t": equilibrium_torque_tolerance_t,
        "equilibrium_torque_tolerance_a_per_m": equilibrium_torque_tolerance_a_per_m,
    },
)

study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-4,
    max_iterations=1000,
)
study.objects.mesh.defaults(
    periodic_pair_ids=["x_faces", "y_faces"],
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=8,
    narrow_regions=1,
)
study.build_domain_mesh()
study.solver(fix_dt=1e-13, g=2.115)

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=tuple(range(save_mode_count)))

study.stages.add_minimize(
    method="bb",
    max_steps=4000,
    tolA=equilibrium_torque_tolerance_a_per_m,
)
if device == "gpu":
    study.stages.change_device("gpu")
study.stages.add_eigenmodes(
    count=mode_count,
    target="frequency_window",
    frequency_min=frequency_min_hz,
    frequency_max=frequency_max_hz,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc=fm.PeriodicBC(["x_faces", "y_faces"]),
    magnetostatic_bc="periodic_airbox_k0",
)
