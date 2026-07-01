"""Relax a 3x3 periodic Permalloy antidot supercell with exchange-coupled repeats.

Geometry:
    - Primitive workload: 200 nm x 200 nm x 10 nm Permalloy film cell.
    - Supercell: 3 x 3 repeated primitive cells, 600 nm x 600 nm x 10 nm.
    - Central circular hole in each primitive cell: 25 nm radius.
    - Periodic supercell: 600 nm x 600 nm laterally, with x/y PBC at the
      outer supercell boundary.
    - PBC is intentionally x/y only: this is a 2D film array with open z,
      not a fully 3D-periodic stack.

Run with:
    fullmag --dev -i examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py
"""

import fullmag as fm


study = fm.study("fem_periodic_antidot_relax_exchange_coupled_supercell_3x3")

# Engine and universe
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(600e-9, 600e-9, 90e-9),
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
film = fm.Box(size=(600e-9, 600e-9, 10e-9), name="periodic_antidot_supercell_base")
hole_xm1_ym1 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_xm1_ym1").translate((-200e-9, -200e-9, 0.0))
hole_xm1_y0 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_xm1_y0").translate((-200e-9, 0.0, 0.0))
hole_xm1_yp1 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_xm1_yp1").translate((-200e-9, 200e-9, 0.0))
hole_x0_ym1 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_x0_ym1").translate((0.0, -200e-9, 0.0))
hole_x0_y0 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_x0_y0").translate((0.0, 0.0, 0.0))
hole_x0_yp1 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_x0_yp1").translate((0.0, 200e-9, 0.0))
hole_xp1_ym1 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_xp1_ym1").translate((200e-9, -200e-9, 0.0))
hole_xp1_y0 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_xp1_y0").translate((200e-9, 0.0, 0.0))
hole_xp1_yp1 = fm.Cylinder(radius=25e-9, height=10e-9, name="hole_xp1_yp1").translate((200e-9, 200e-9, 0.0))
holes = (
    hole_xm1_ym1
    + hole_xm1_y0
    + hole_xm1_yp1
    + hole_x0_ym1
    + hole_x0_y0
    + hole_x0_yp1
    + hole_xp1_ym1
    + hole_xp1_y0
    + hole_xp1_yp1
)
body = study.geometry(film - holes, name="periodic_antidot_supercell_film")

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

hole_transition_xm1_ym1 = body.add_region(
    "hole_transition_refinement_xm1_ym1",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_xm1_ym1").translate((-200e-9, -200e-9, 0.0)),
    priority=10,
)
hole_transition_xm1_ym1.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_xm1_y0 = body.add_region(
    "hole_transition_refinement_xm1_y0",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_xm1_y0").translate((-200e-9, 0.0, 0.0)),
    priority=10,
)
hole_transition_xm1_y0.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_xm1_yp1 = body.add_region(
    "hole_transition_refinement_xm1_yp1",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_xm1_yp1").translate((-200e-9, 200e-9, 0.0)),
    priority=10,
)
hole_transition_xm1_yp1.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_x0_ym1 = body.add_region(
    "hole_transition_refinement_x0_ym1",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_x0_ym1").translate((0.0, -200e-9, 0.0)),
    priority=10,
)
hole_transition_x0_ym1.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_x0_y0 = body.add_region(
    "hole_transition_refinement_x0_y0",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_x0_y0").translate((0.0, 0.0, 0.0)),
    priority=10,
)
hole_transition_x0_y0.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_x0_yp1 = body.add_region(
    "hole_transition_refinement_x0_yp1",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_x0_yp1").translate((0.0, 200e-9, 0.0)),
    priority=10,
)
hole_transition_x0_yp1.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_xp1_ym1 = body.add_region(
    "hole_transition_refinement_xp1_ym1",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_xp1_ym1").translate((200e-9, -200e-9, 0.0)),
    priority=10,
)
hole_transition_xp1_ym1.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_xp1_y0 = body.add_region(
    "hole_transition_refinement_xp1_y0",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_xp1_y0").translate((200e-9, 0.0, 0.0)),
    priority=10,
)
hole_transition_xp1_y0.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)
hole_transition_xp1_yp1 = body.add_region(
    "hole_transition_refinement_xp1_yp1",
    fm.Cylinder(radius=43e-9, height=10e-9, name="transition_xp1_yp1").translate((200e-9, 200e-9, 0.0)),
    priority=10,
)
hole_transition_xp1_yp1.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=54e-9,
    # transition_distance=14e-9,
    order=1,
)

# Scenario provenance
study.runtime_metadata(
    "periodic_antidot_relaxation",
    {
        "scenario": "exchange_coupled",
        "exchange_coupled_across_periods": True,
        "magnetostatic_pbc": "periodic_airbox_k0",
        "periodic_pair_ids": ["x_faces", "y_faces"],
        "film_size_m": [200e-9, 200e-9, 10e-9],
        "universe_size_m": [600e-9, 600e-9, 90e-9],
        "lateral_air_gap_m": [0.0, 0.0],
        "supercell_repeat": [3, 3],
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
    tol=5.0e3,  # A/m
)
