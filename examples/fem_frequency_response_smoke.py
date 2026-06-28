"""FEM relax-then-driven FMR spectrum smoke for a periodic Py film with a hole.

This exercises the native FEM/MFEM lane for the production workflow expected by
the UI: relax the equilibrium state first, then compute the driven harmonic
response from that relaxed state at explicitly requested probe frequencies.

The model is a 200 x 200 x 10 nm Permalloy unit cell with x/y periodic
spin-wave boundary conditions, a centered 50 nm diameter hole, and a 10 mT
in-plane bias along +x. The response is sampled over a compact GHz sweep around
the expected low-field Py FMR band.

The frequency-response stage intentionally keeps demag disabled until the
dynamic periodic-airbox coupled block is implemented. The runtime smoke is
therefore authored as a magnetic-domain mesh, not a shared-domain airbox mesh:
200 x 200 nm lateral cell, periodic x/y pairs, four through-thickness layers,
and explicit sub-exchange-length refinement around the hole edge.
"""

import fullmag as fm

NM = 1e-9

FILM_SIZE = (200 * NM, 200 * NM, 10 * NM)
MESH_ALGORITHM_2D = 6
MESH_ALGORITHM_3D = 1
MESH_SMOOTHING_STEPS = 4
MESH_OPTIMIZE_ITERATIONS = 3
MESH_SIZE_FROM_CURVATURE = 24
MESH_NARROW_REGIONS = 3

HOLE_RADIUS = 25 * NM
HOLE_EDGE_REFINEMENT_RADIUS = HOLE_RADIUS + 5 * NM
HOLE_TRANSITION_REFINEMENT_RADIUS = HOLE_RADIUS + 18 * NM

FILM_THROUGH_THICKNESS_LAYERS = 4
FILM_MIN_ELEMENT_SIZE = 2.5 * NM
FILM_MAX_ELEMENT_SIZE = 5 * NM
FILM_INTERFACE_MAX_ELEMENT_SIZE = 3.5 * NM
FILM_EDGE_MAX_ELEMENT_SIZE = 2.8 * NM
HOLE_TRANSITION_MAX_ELEMENT_SIZE = 4 * NM
HOLE_EDGE_MIN_ELEMENT_SIZE = 2 * NM
HOLE_EDGE_MAX_ELEMENT_SIZE = 2.5 * NM

APPLIED_B_T = (10e-3, 0.0, 0.0)
PROBE_FREQUENCIES_HZ = [
    freq_ghz * 1e9
    for freq_ghz in (1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0)
]
PERIODIC_BC = fm.PeriodicBC(["x_faces", "y_faces"]).to_ir()


def apply_periodic_airbox_mesh_policy(body) -> None:
    body.mesh.thin_film(
        minimum_element_size=FILM_MIN_ELEMENT_SIZE,
        maximum_element_size=FILM_MAX_ELEMENT_SIZE,
        interface_maximum_element_size=FILM_INTERFACE_MAX_ELEMENT_SIZE,
        interface_thickness=8 * NM,
        transition_distance=20 * NM,
        edge_maximum_element_size=FILM_EDGE_MAX_ELEMENT_SIZE,
        edge_thickness=5 * NM,
        edge_transition_distance=12 * NM,
        corner_maximum_element_size=FILM_EDGE_MAX_ELEMENT_SIZE,
        corner_extent=5 * NM,
        corner_transition_distance=10 * NM,
        curvature_factor=0.25,
        narrow_region_resolution=1.5,
        layers=FILM_THROUGH_THICKNESS_LAYERS,
        order=1,
    )
    hole_transition_refinement = body.add_region(
        "hole_transition_refinement",
        fm.Cylinder(radius=HOLE_TRANSITION_REFINEMENT_RADIUS, height=FILM_SIZE[2]),
        priority=10,
    )
    hole_transition_refinement.mesh(
        minimum_element_size=FILM_MIN_ELEMENT_SIZE,
        maximum_element_size=HOLE_TRANSITION_MAX_ELEMENT_SIZE,
        transition_distance=14 * NM,
        order=1,
    )
    hole_edge_refinement = body.add_region(
        "hole_edge_refinement",
        fm.Cylinder(radius=HOLE_EDGE_REFINEMENT_RADIUS, height=FILM_SIZE[2]),
        priority=20,
    )
    hole_edge_refinement.mesh(
        minimum_element_size=HOLE_EDGE_MIN_ELEMENT_SIZE,
        maximum_element_size=HOLE_EDGE_MAX_ELEMENT_SIZE,
        transition_distance=6 * NM,
        order=1,
    )


study = fm.study("fem_frequency_response_smoke")
study.engine("fem")
study.device("cpu", precision="double")
study.objects.mesh.defaults(
    periodic_pair_ids=PERIODIC_BC["pair_ids"],
    algorithm_2d=MESH_ALGORITHM_2D,
    algorithm_3d=MESH_ALGORITHM_3D,
    smoothing_steps=MESH_SMOOTHING_STEPS,
    optimize_iterations=MESH_OPTIMIZE_ITERATIONS,
    size_from_curvature=MESH_SIZE_FROM_CURVATURE,
    narrow_regions=MESH_NARROW_REGIONS,
)

body = study.geometry(
    fm.Box(size=FILM_SIZE, name="periodic_film")
    - fm.Cylinder(radius=HOLE_RADIUS, height=FILM_SIZE[2], name="central_hole"),
    name="periodic_film",
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
apply_periodic_airbox_mesh_policy(body)

study.b_ext(*APPLIED_B_T)
study.demag(enabled=False)
study.solver(dt=1e-13, g=2.115)
study.tableautosave(1e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])

study.save("m", every=10e-12)
study.save_response("susceptibility_tensor")

study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=2000,
    tol=1e-5,
)
study.stages.add_frequency_response(
    frequencies_hz=PROBE_FREQUENCIES_HZ,
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=False,
    equilibrium_source="relax",
    damping_policy="include",
    bc=PERIODIC_BC,
)
