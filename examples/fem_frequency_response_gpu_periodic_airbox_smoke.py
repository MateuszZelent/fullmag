"""FEM GPU k=0 periodic-airbox dynamic-demag provider smoke.

This requests the production GPU provider path: explicit GPU, k=0 periodic
dynamic magnetization, shared-domain airbox demag, and
``magnetostatic_bc="periodic_airbox_k0"``. The backend must keep the requested
GPU lane and solve through the device-resident periodic-airbox demag provider,
not through CPU fallback or an explicit dense coupled-block payload.
"""

import os

import fullmag as fm


def _frequencies_hz():
    raw = os.environ.get("FULLMAG_FMR_PERIODIC_AIRBOX_GPU_FREQUENCIES_HZ")
    if raw is None or not raw.strip():
        return [1.0e9, 2.0e9]
    values = [float(item.strip()) for item in raw.split(",") if item.strip()]
    if not values:
        raise ValueError("FULLMAG_FMR_PERIODIC_AIRBOX_GPU_FREQUENCIES_HZ must not be empty")
    return values


study = fm.study("fem_frequency_response_gpu_periodic_airbox_smoke")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(40e-9, 20e-9, 50e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=20e-9,
    maximum_element_size=40e-9,
    growth_rate=1.5,
    grading="linear",
)
study.objects.mesh.defaults(
    periodic_pair_ids=["x_faces"],
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=4,
    narrow_regions=1,
)

body = study.geometry(fm.Box(size=(40e-9, 20e-9, 10e-9), name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=10e-9,
    maximum_element_size=20e-9,
    interface_maximum_element_size=20e-9,
    edge_thickness=2e-9,
    edge_transition_distance=4e-9,
    corner_extent=2e-9,
    corner_transition_distance=4e-9,
    layers=1,
    order=1,
)

study.b_ext(10e-3, 0.0, 0.0)
study.pbc(x=True, demag="periodic_airbox_k0")
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.save_response("susceptibility_tensor")
study.stages.change_device("gpu")
study.stages.add_frequency_response(
    frequencies_hz=_frequencies_hz(),
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=True,
    equilibrium_source="provided",
    damping_policy="include",
    bc=fm.PeriodicBC(["x_faces"]),
    magnetostatic_bc="periodic_airbox_k0",
)
