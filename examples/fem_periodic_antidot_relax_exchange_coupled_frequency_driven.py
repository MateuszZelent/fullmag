"""Relax a periodic Permalloy antidot unit cell, then run GPU driven response.

Geometry:
    - Permalloy film: 200 nm x 200 nm x 10 nm.
    - Central circular hole: 25 nm radius.
    - Periodic unit cell: 200 nm x 200 nm laterally, so opposite magnetic
      boundaries touch their periodic neighbours.
    - PBC is intentionally x/y only: this is a 2D film array with open z,
      not a fully 3D-periodic stack.
    - The relaxation stage uses periodic-airbox demag. The frequency-response
      stage is the currently executable MFEM GPU static-periodic magnetic
      slice with ordinary k=0 dynamic demag through the backend tangent
      provider, not GPU periodic-airbox Poisson.

Run with:
    fullmag --dev -i examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py
    just run-fem-periodic-antidot-frequency-driven-managed-headless
"""

import fullmag as fm


study = fm.study("fem_periodic_antidot_relax_exchange_coupled_frequency_driven")

# Engine and universe
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(200e-9, 200e-9, 90e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5e-9,
    maximum_element_size=20e-9,
    growth_rate=1.5,
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.interactive(True)

# Geometry
film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="periodic_antidot_base")
hole = fm.Cylinder(radius=25e-9, height=10e-9, name="central_hole")
body = study.geometry(film - hole, name="periodic_antidot_film")

# Material and mesh
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=8e-9,
    # interface_maximum_element_size=14e-9,
    # interface_thickness=8e-9,
    # transition_distance=20e-9,
    # edge_maximum_element_size=12e-9,
    # edge_thickness=5e-9,
    # edge_transition_distance=12e-9,
    # corner_maximum_element_size=12e-9,
    # corner_extent=5e-9,
    # corner_transition_distance=10e-9,
    curvature_factor=0.25,
    narrow_region_resolution=1.5,
    layers=1,
    order=1,
)

hole_transition = body.add_region(
    "hole_transition_refinement",
    fm.Cylinder(radius=43e-9, height=10e-9, name="hole_transition_refinement"),
    priority=10,
)
hole_transition.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)

# hole_edge = body.add_region(
#     "hole_edge_refinement",
#     fm.Cylinder(radius=30e-9, height=10e-9, name="hole_edge_refinement"),
#     priority=20,
# )
# hole_edge.mesh(
#     minimum_element_size=8e-9,
#     maximum_element_size=12e-9,
#     transition_distance=6e-9,
#     order=1,
# )

# Scenario provenance
study.runtime_metadata(
    "periodic_antidot_relaxation",
    {
        "scenario": "exchange_coupled_frequency_driven",
        "exchange_coupled_across_periods": True,
        "magnetostatic_pbc": "periodic_airbox_k0",
        "frequency_response_device": "gpu",
        "frequency_response_dynamic_demag": True,
        "frequency_response_magnetostatic_bc": "open",
        "periodic_pair_ids": ["x_faces", "y_faces"],
        "film_size_m": [200e-9, 200e-9, 10e-9],
        "universe_size_m": [200e-9, 200e-9, 90e-9],
        "lateral_air_gap_m": [0.0, 0.0],
    },
)

# Interactions, mesh, and solver
study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-4,
    max_iterations=500,
)
study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=8,
    narrow_regions=1,
)
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.tableautosave(
    1e-12,
    quantities=[
        "time",
        "step",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "E_total",
        "max_h_demag",
        "max_torque",
    ],
)
study.save("m", every=10e-12)
study.save("H_demag", every=10e-12)
study.save("H_eff", every=10e-12)
study.save("demag_phi", every=10e-12)

study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=4000,
    tol=5.0e-4,  # A/m
)

# Current MFEM GPU frequency response supports the static-periodic magnetic
# slice with ordinary k=0 dynamic demag through the backend tangent provider,
# but not GPU periodic-airbox Poisson. Keep the already-captured relaxation
# stage above with periodic-airbox demag outputs, then request the dynamic
# response with magnetostatic_bc="open".
study.clear_outputs()
study.stages.change_device("gpu")

study.stages.add_frequency_response(
    frequencies_hz=[
        2.0e9,
        2.5e9,
        3.0e9,
        3.5e9,
        4.0e9,
        4.5e9,
        5.0e9,
    ],
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=True,
    equilibrium_source="relax",
    damping_policy="include",
    bc=fm.PeriodicBC(["x_faces", "y_faces"]),
    magnetostatic_bc="open",
)
