"""Relax a periodic Permalloy antidot and compute its K0 eigenmodes.

The unit cell is periodic in x/y and open in z. Dynamic demagnetization uses
the same periodic Poisson-airbox domain as the relaxed equilibrium.

Run with:
    fullmag --dev -i examples/fem_periodic_antidot_relax_eigenmodes.py
"""

import math
import os

import fullmag as fm
from fullmag.runtime.periodic_antidot_equilibrium_cache import (
    load_periodic_antidot_equilibrium_cache,
)


device = os.environ.get("FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE", "cpu")
if device not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE must be 'cpu' or 'gpu'")

domain_mesh_override = os.environ.get("FULLMAG_PERIODIC_ANTIDOT_EIGEN_DOMAIN_MESH")
equilibrium_state_override = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_EQUILIBRIUM_STATE"
)
equilibrium_cache_override = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE"
)
equilibrium_cache = None
if equilibrium_cache_override:
    if domain_mesh_override or equilibrium_state_override:
        raise ValueError(
            "FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE cannot be combined with "
            "FULLMAG_PERIODIC_ANTIDOT_EIGEN_DOMAIN_MESH or "
            "FULLMAG_PERIODIC_ANTIDOT_EIGEN_EQUILIBRIUM_STATE"
        )
    equilibrium_cache = load_periodic_antidot_equilibrium_cache(
        equilibrium_cache_override
    )
    domain_mesh_override = str(equilibrium_cache.domain_mesh_path)
    equilibrium_state_override = str(equilibrium_cache.equilibrium_state_path)
if bool(domain_mesh_override) != bool(equilibrium_state_override):
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_DOMAIN_MESH and "
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_EQUILIBRIUM_STATE must be provided together"
    )

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

modal_target = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_TARGET", "frequency_window"
)
if modal_target not in {"frequency_window", "nearest"}:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_TARGET must be 'frequency_window' or 'nearest', "
        f"got {modal_target!r}"
    )
target_frequency_ghz_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_TARGET_GHZ", "2.0"
)
try:
    target_frequency_ghz = float(target_frequency_ghz_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_TARGET_GHZ must be a number, "
        f"got {target_frequency_ghz_raw!r}"
    ) from exc
if not math.isfinite(target_frequency_ghz) or target_frequency_ghz <= 0.0:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_TARGET_GHZ must be finite and positive"
    )
target_frequency_hz = target_frequency_ghz * 1.0e9

mu0_t_m_per_a = 4.0e-7 * math.pi
# This is the user-authored acceptance criterion for the relaxation stage.
# Eigensolve consumes the resulting certified handoff and does not impose a
# second hidden torque threshold.
equilibrium_torque_tolerance_t_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_RELAX_TOL_T", "1e-6"
)
try:
    equilibrium_torque_tolerance_t = float(equilibrium_torque_tolerance_t_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_RELAX_TOL_T must be a number, "
        f"got {equilibrium_torque_tolerance_t_raw!r}"
    ) from exc
if not math.isfinite(equilibrium_torque_tolerance_t):
    raise ValueError("FULLMAG_PERIODIC_ANTIDOT_RELAX_TOL_T must be finite")
if equilibrium_torque_tolerance_t <= 0.0:
    raise ValueError("FULLMAG_PERIODIC_ANTIDOT_RELAX_TOL_T must be positive")
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
body.m = (
    fm.init.load_magnetization(equilibrium_state_override)
    if equilibrium_state_override
    else fm.init.UniformMagnetization((1.0, 0.0, 0.0))
)
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
        "modal_target": modal_target,
        "target_frequency_hz": target_frequency_hz
        if modal_target == "nearest"
        else None,
        "frequency_window_hz": [frequency_min_hz, frequency_max_hz],
        "mode_count": mode_count,
        "saved_mode_indices": list(range(save_mode_count)),
        "equilibrium_torque_tolerance_t": equilibrium_torque_tolerance_t,
        "equilibrium_torque_tolerance_a_per_m": equilibrium_torque_tolerance_a_per_m,
        "equilibrium_state_source": (
            {
                "kind": "reusable_cache",
                "schema_version": equilibrium_cache.manifest["schema_version"],
                "mesh_generation_id": equilibrium_cache.manifest["mesh"][
                    "mesh_generation_id"
                ],
                "topology_fingerprint": equilibrium_cache.manifest["mesh"][
                    "topology_fingerprint"
                ],
            }
            if equilibrium_cache is not None
            else {"kind": "stage_relaxation"}
        ),
    },
)

study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    atol=1e-20,
    max_iterations=2000,
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
if domain_mesh_override:
    study.domain_mesh(
        domain_mesh_override,
        region_markers=[
            {"geometry_name": "periodic_antidot_film_geom", "marker": 1}
        ],
        object_region_markers=[
            {"geometry_name": "periodic_antidot_film:r1", "marker": 2}
        ],
    )
else:
    study.build_domain_mesh()
study.solver(fix_dt=1e-11, g=2.115)

study.save("spectrum")
study.save("mode", indices=tuple(range(save_mode_count)))

study.stages.add_relax(
    algorithm="nonlinear_cg",
    max_steps=16000,
    tolA=equilibrium_torque_tolerance_a_per_m,
)
if device == "gpu":
    study.stages.change_device("gpu")
study.stages.add_eigenmodes(
    count=mode_count,
    target=modal_target,
    target_frequency=target_frequency_hz if modal_target == "nearest" else None,
    frequency_min=frequency_min_hz if modal_target == "frequency_window" else None,
    frequency_max=frequency_max_hz if modal_target == "frequency_window" else None,
    operator="full_2x2",
    include_demag=True,
    # Materialize and certify the accepted equilibrium at the first modal
    # sample.  The runner binds it to the continued stage state and exact mesh
    # identity; subsequent samples may reuse it as Provided only through that
    # immutable handoff, without another mesh build or independent relaxation.
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc=fm.PeriodicBC(["x_faces", "y_faces"]),
    magnetostatic_bc="periodic_airbox_k0",
)
