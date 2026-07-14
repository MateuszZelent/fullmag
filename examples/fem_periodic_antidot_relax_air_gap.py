"""Relax a periodic Permalloy antidot cell separated by lateral air gaps.

Geometry:
    - Permalloy film: 200 nm x 200 nm x 10 nm.
    - Central circular hole: 25 nm radius.
    - Periodic airbox: 320 nm x 320 nm laterally, so repeated ferromagnetic
      films are separated by 120 nm of lateral air.
    - PBC is intentionally x/y only: this is a 2D film array with open z,
      not a fully 3D-periodic stack.

Run with:
    fullmag --dev -i examples/fem_periodic_antidot_relax_air_gap.py
"""

import fullmag as fm


study = fm.study("fem_periodic_antidot_relax_air_gap")

# Engine and universe
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(320e-9, 320e-9, 90e-9),
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
    maximum_element_size=5e-9,
    # transition_distance=10e-9,
    # order=1,
)

# Scenario provenance
study.runtime_metadata(
    "periodic_antidot_relaxation",
    {
        "scenario": "air_gap",
        "exchange_coupled_across_periods": False,
        "magnetostatic_pbc": "periodic_airbox_k0",
        "periodic_pair_ids": ["x_faces", "y_faces"],
        "film_size_m": [200e-9, 200e-9, 10e-9],
        "universe_size_m": [320e-9, 320e-9, 90e-9],
        "lateral_air_gap_m": [120e-9, 120e-9],
    },
)

# Interactions, mesh, and solver
study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
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
study.save("demag_phi", every=10e-12)

study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=4000,
    tol=5.0e3,  # A/m
)
