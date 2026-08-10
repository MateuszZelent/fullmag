"""Small FEM shared-domain k=0 static-periodic no-demag response smoke.

This exercises the CPU/GPU compacted magnetic-node response slice on a
shared-domain airbox mesh. The airbox is present because the mesh workflow is
shared-domain, but the driven response deliberately disables dynamic demag.
Set ``FULLMAG_FMR_DEVICE=cpu`` or ``FULLMAG_FMR_DEVICE=gpu``.
"""

import os

import fullmag as fm


device = os.environ.get("FULLMAG_FMR_DEVICE", "gpu").strip().lower()
if device not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_FMR_DEVICE must be 'cpu' or 'gpu'")

study = fm.study("fem_frequency_response_shared_domain_static_periodic_smoke")
study.engine("fem")
study.device(device, precision="double")
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

study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.save_response("susceptibility_tensor")

study.demag(enabled=False)
study.stages.add_frequency_response(
    frequencies_hz=[1.0e9, 2.0e9],
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=False,
    equilibrium_source="provided",
    damping_policy="include",
    bc=fm.PeriodicBC(["x_faces"]),
)
