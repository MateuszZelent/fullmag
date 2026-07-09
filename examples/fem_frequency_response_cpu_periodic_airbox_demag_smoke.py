"""Small FEM CPU k=0 periodic-airbox frequency-response smoke with dynamic demag."""

import fullmag as fm


study = fm.study("fem_frequency_response_cpu_periodic_airbox_demag_smoke")
study.engine("fem")
study.device("cpu", precision="double")

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
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.save_response("susceptibility_tensor")

study.stages.add_frequency_response(
    frequencies_hz=[1.0e9],
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=True,
    equilibrium_source="provided",
    damping_policy="include",
    bc=fm.PeriodicBC(["x_faces"]),
    magnetostatic_bc="periodic_airbox_k0",
)
