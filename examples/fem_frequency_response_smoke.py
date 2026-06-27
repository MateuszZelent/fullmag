"""FEM relax-then-driven FMR spectrum smoke for a periodic Py film with a hole.

This exercises the native FEM/MFEM lane for the production workflow expected by
the UI: relax the equilibrium state first, then compute the driven harmonic
response from that relaxed state at explicitly requested probe frequencies.

The model is a 200 x 200 x 10 nm Permalloy unit cell with x/y periodic
spin-wave boundary conditions, a centered 50 nm diameter hole, and a 10 mT
in-plane bias along +x. The response is sampled over a compact GHz sweep around
the expected low-field Py FMR band.
"""

import fullmag as fm

NM = 1e-9

FILM_SIZE = (200 * NM, 200 * NM, 10 * NM)
HOLE_RADIUS = 25 * NM
APPLIED_B_T = (10e-3, 0.0, 0.0)
PROBE_FREQUENCIES_HZ = [
    freq_ghz * 1e9
    for freq_ghz in (1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0)
]
PERIODIC_BC = fm.PeriodicBC(["x_faces", "y_faces"]).to_ir()


study = fm.study("fem_frequency_response_smoke")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=FILM_SIZE,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=40 * NM)

body = study.geometry(
    fm.Box(size=FILM_SIZE, name="periodic_film")
    - fm.Cylinder(radius=HOLE_RADIUS, height=FILM_SIZE[2], name="central_hole"),
    name="periodic_film",
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(minimum_element_size=4 * NM, maximum_element_size=10 * NM, order=1)

hole_refinement = body.add_region(
    "hole_refinement",
    fm.Cylinder(radius=HOLE_RADIUS + 15 * NM, height=FILM_SIZE[2]),
    priority=10,
)
hole_refinement.mesh(
    minimum_element_size=3 * NM,
    maximum_element_size=5 * NM,
    transition_distance=20 * NM,
    order=1,
)

study.build_domain_mesh()
study.b_ext(*APPLIED_B_T)
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
