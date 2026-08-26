"""FEM GPU nonzero-k Floquet airbox dynamic-demag unavailable smoke.

This script intentionally requests the future production path: explicit GPU,
nonzero-k Floquet dynamic magnetization, shared-domain airbox demag, and
``magnetostatic_bc="floquet_airbox"``. The current backend must publish
artifact-backed unavailable diagnostics instead of silently falling back to CPU
or erasing the requested magnetostatic boundary model.
"""

import os

import fullmag as fm

NM = 1e-9


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else float(raw)


KX_RAD_PER_M = env_float("FULLMAG_FMR_FLOQUET_KX_RAD_PER_M", 1.0e6)

FILM_SIZE = (40 * NM, 20 * NM, 10 * NM)
AIRBOX_SIZE = (40 * NM, 20 * NM, 50 * NM)
PAIR_IDS = ["x_faces"]

study = fm.study("fem_frequency_response_gpu_floquet_airbox_unsupported_smoke")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=AIRBOX_SIZE,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=20 * NM,
    maximum_element_size=40 * NM,
    growth_rate=1.5,
    grading="linear",
)
study.objects.mesh.defaults(
    periodic_pair_ids=PAIR_IDS,
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=4,
    narrow_regions=1,
)

body = study.geometry(fm.Box(size=FILM_SIZE, name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=10 * NM,
    maximum_element_size=20 * NM,
    interface_maximum_element_size=20 * NM,
    edge_thickness=2 * NM,
    edge_transition_distance=4 * NM,
    corner_extent=2 * NM,
    corner_transition_distance=4 * NM,
    layers=1,
    order=1,
)

study.b_ext(10e-3, 0.0, 0.0)
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.save_response("susceptibility_tensor")
study.stages.add_frequency_response(
    frequencies_hz=[1.0e9, 2.0e9],
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=True,
    equilibrium_source="provided",
    damping_policy="include",
    bc=fm.FloquetBC(PAIR_IDS),
    k_vector=(KX_RAD_PER_M, 0.0, 0.0),
    magnetostatic_bc="floquet_airbox",
)
