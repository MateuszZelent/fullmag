"""FEM relax-then-driven FMR spectrum smoke for a periodic Py film with a hole.

This exercises the native FEM/MFEM lane for the production workflow expected by
the UI: relax the equilibrium state first, then compute the driven harmonic
response from that relaxed state at explicitly requested probe frequencies.

The model is a 200 x 200 x 10 nm Permalloy unit cell with x/y periodic
spin-wave boundary conditions, a centered 50 nm diameter hole, and a 10 mT
in-plane bias along +x. The response is sampled over a compact GHz sweep around
the expected low-field Py FMR band.

The frequency-response stage requests the CPU ``periodic_airbox_k0`` dynamic
demag path. The lateral magnetic and airbox cuts are zero-phase periodic x/y
boundaries for one cell of the infinite antidot lattice; only the top/bottom
airbox faces approximate open space through the Poisson-Robin realization.
"""

import os

import fullmag as fm

NM = 1e-9


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else int(raw)


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else float(raw)


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else raw.strip()


FAST_RUNTIME_MESH = env_bool("FULLMAG_FMR_FAST_RUNTIME_MESH")
FMR_DEVICE = env_str("FULLMAG_FMR_DEVICE", "cpu")
FMR_EQUILIBRIUM_SOURCE = env_str("FULLMAG_FMR_EQUILIBRIUM_SOURCE", "relax")
if FMR_EQUILIBRIUM_SOURCE not in {"relax", "provided"}:
    raise ValueError("FULLMAG_FMR_EQUILIBRIUM_SOURCE must be 'relax' or 'provided'")
FROZEN_MAGNETIC_SUBMESH_SOURCE = env_str("FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE", "")
FROZEN_MAGNETIC_AIR_MESH_SOURCE = env_str("FULLMAG_FMR_FROZEN_MAGNETIC_AIR_MESH_SOURCE", "")
SUPERCELL_REPEAT_X = env_int("FULLMAG_FMR_SUPERCELL_REPEAT_X", 1)
SUPERCELL_REPEAT_Y = env_int("FULLMAG_FMR_SUPERCELL_REPEAT_Y", 1)
if SUPERCELL_REPEAT_X <= 0 or SUPERCELL_REPEAT_Y <= 0:
    raise ValueError("FULLMAG_FMR_SUPERCELL_REPEAT_X/Y must be positive integers")

UNIT_CELL_SIZE = (200 * NM, 200 * NM, 10 * NM)
FILM_SIZE = (
    UNIT_CELL_SIZE[0] * SUPERCELL_REPEAT_X,
    UNIT_CELL_SIZE[1] * SUPERCELL_REPEAT_Y,
    UNIT_CELL_SIZE[2],
)
AIRBOX_THICKNESS = env_float("FULLMAG_FMR_AIRBOX_THICKNESS_NM", 90.0) * NM
if AIRBOX_THICKNESS <= FILM_SIZE[2]:
    raise ValueError("FULLMAG_FMR_AIRBOX_THICKNESS_NM must exceed the 10 nm film thickness")
AIRBOX_SIZE = (FILM_SIZE[0], FILM_SIZE[1], AIRBOX_THICKNESS)
AIRBOX_MAX_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_AIRBOX_MAX_ELEMENT_SIZE_NM",
    120.0 if FAST_RUNTIME_MESH else 60.0,
) * NM
AIRBOX_MIN_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_AIRBOX_MIN_ELEMENT_SIZE_NM",
    16.0 if FAST_RUNTIME_MESH else 8.0,
) * NM
AIRBOX_GROWTH_RATE = 1.5
MESH_ALGORITHM_2D = 6
MESH_ALGORITHM_3D = env_int("FULLMAG_FMR_MESH_ALGORITHM_3D", 1)
MESH_SMOOTHING_STEPS = env_int("FULLMAG_FMR_MESH_SMOOTHING_STEPS", 1 if FAST_RUNTIME_MESH else 4)
MESH_OPTIMIZE_ITERATIONS = env_int("FULLMAG_FMR_MESH_OPTIMIZE_ITERATIONS", 1 if FAST_RUNTIME_MESH else 3)
MESH_SIZE_FROM_CURVATURE = env_int("FULLMAG_FMR_MESH_SIZE_FROM_CURVATURE", 8 if FAST_RUNTIME_MESH else 24)
MESH_NARROW_REGIONS = env_int("FULLMAG_FMR_MESH_NARROW_REGIONS", 1 if FAST_RUNTIME_MESH else 3)

HOLE_RADIUS = 25 * NM
HOLE_EDGE_REFINEMENT_RADIUS = HOLE_RADIUS + 5 * NM
HOLE_TRANSITION_REFINEMENT_RADIUS = HOLE_RADIUS + 18 * NM

FILM_THROUGH_THICKNESS_LAYERS = env_int(
    "FULLMAG_FMR_FILM_THROUGH_THICKNESS_LAYERS",
    1 if FAST_RUNTIME_MESH else 2,
)
FILM_MIN_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_FILM_MIN_ELEMENT_SIZE_NM",
    8.0 if FAST_RUNTIME_MESH else 3.0,
) * NM
FILM_MAX_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_FILM_MAX_ELEMENT_SIZE_NM",
    20.0 if FAST_RUNTIME_MESH else 8.0,
) * NM
FILM_INTERFACE_MAX_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_FILM_INTERFACE_MAX_ELEMENT_SIZE_NM",
    14.0 if FAST_RUNTIME_MESH else 5.0,
) * NM
FILM_EDGE_MAX_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_FILM_EDGE_MAX_ELEMENT_SIZE_NM",
    12.0 if FAST_RUNTIME_MESH else 4.0,
) * NM
HOLE_TRANSITION_MAX_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_HOLE_TRANSITION_MAX_ELEMENT_SIZE_NM",
    14.0 if FAST_RUNTIME_MESH else 6.0,
) * NM
HOLE_EDGE_MIN_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_HOLE_EDGE_MIN_ELEMENT_SIZE_NM",
    8.0 if FAST_RUNTIME_MESH else 3.0,
) * NM
HOLE_EDGE_MAX_ELEMENT_SIZE = env_float(
    "FULLMAG_FMR_HOLE_EDGE_MAX_ELEMENT_SIZE_NM",
    12.0 if FAST_RUNTIME_MESH else 4.0,
) * NM

APPLIED_B_T = (10e-3, 0.0, 0.0)
DEFAULT_PROBE_FREQUENCIES_GHZ = (1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0)
PERIODIC_PAIR_IDS = ["x_faces", "y_faces"]
PERIODIC_BC = fm.PeriodicBC(PERIODIC_PAIR_IDS)


def lattice_offsets(repeat: int, pitch: float) -> list[float]:
    center = 0.5 * (repeat - 1)
    return [(index - center) * pitch for index in range(repeat)]


def hole_centers() -> list[tuple[float, float]]:
    return [
        (x, y)
        for x in lattice_offsets(SUPERCELL_REPEAT_X, UNIT_CELL_SIZE[0])
        for y in lattice_offsets(SUPERCELL_REPEAT_Y, UNIT_CELL_SIZE[1])
    ]


def translated_cylinder(radius: float, height: float, center: tuple[float, float], name: str):
    cylinder = fm.Cylinder(radius=radius, height=height, name=name)
    if center == (0.0, 0.0):
        return cylinder
    return cylinder.translate((center[0], center[1], 0.0))


def union_geometries(geometries: list[object]):
    if not geometries:
        raise ValueError("supercell antidot geometry requires at least one hole")
    current = geometries[0]
    for geometry in geometries[1:]:
        current = current + geometry
    return current


def periodic_antidot_geometry():
    centers = hole_centers()
    holes = [
        translated_cylinder(
            HOLE_RADIUS,
            FILM_SIZE[2],
            center,
            "central_hole" if len(centers) == 1 else f"hole_{index}",
        )
        for index, center in enumerate(centers)
    ]
    return fm.Difference(
        base=fm.Box(size=FILM_SIZE, name="periodic_film_base"),
        tool=union_geometries(holes),
        name="periodic_film",
    )


def probe_frequencies_hz() -> list[float]:
    raw = os.environ.get("FULLMAG_FMR_FREQUENCIES_GHZ")
    if raw is None or raw.strip() == "":
        values_ghz = DEFAULT_PROBE_FREQUENCIES_GHZ
    else:
        values_ghz = tuple(
            float(token.strip())
            for token in raw.replace(";", ",").split(",")
            if token.strip()
        )
        if not values_ghz:
            raise ValueError("FULLMAG_FMR_FREQUENCIES_GHZ must contain at least one value")
    return [freq_ghz * 1e9 for freq_ghz in values_ghz]


RELAX_MAX_STEPS = env_int("FULLMAG_FMR_RELAX_MAX_STEPS", 200)
RELAX_TOL = env_float("FULLMAG_FMR_RELAX_TOL", 3e-3)
DEMAG_SOLVER_RTOL = env_float("FULLMAG_FMR_DEMAG_RTOL", 1e-4)
DEMAG_SOLVER_MAX_ITERATIONS = env_int("FULLMAG_FMR_DEMAG_MAX_ITERATIONS", 500)
RESPONSE_SOLVER_RTOL = env_float("FULLMAG_FMR_RESPONSE_RTOL", 1e-3)
RESPONSE_SOLVER_MAX_ITERATIONS = env_int("FULLMAG_FMR_RESPONSE_MAX_ITERATIONS", 2048)
RESPONSE_SOLVER_RESTART_ITERATIONS = env_int("FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS", 2048)
PROBE_FREQUENCIES_HZ = probe_frequencies_hz()

os.environ["FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL"] = str(RESPONSE_SOLVER_RTOL)
os.environ["FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS"] = str(
    RESPONSE_SOLVER_MAX_ITERATIONS
)
os.environ["FULLMAG_FEM_FREQUENCY_RESPONSE_RESTART_ITERATIONS"] = str(
    RESPONSE_SOLVER_RESTART_ITERATIONS
)


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
    centers = hole_centers()
    for index, center in enumerate(centers):
        suffix = "" if len(centers) == 1 else f"_{index}"
        hole_transition_refinement = body.add_region(
            f"hole_transition_refinement{suffix}",
            translated_cylinder(
                HOLE_TRANSITION_REFINEMENT_RADIUS,
                FILM_SIZE[2],
                center,
                f"hole_transition_refinement{suffix}",
            ),
            priority=10,
        )
        hole_transition_refinement.mesh(
            minimum_element_size=FILM_MIN_ELEMENT_SIZE,
            maximum_element_size=HOLE_TRANSITION_MAX_ELEMENT_SIZE,
            transition_distance=14 * NM,
            order=1,
        )
        hole_edge_refinement = body.add_region(
            f"hole_edge_refinement{suffix}",
            translated_cylinder(
                HOLE_EDGE_REFINEMENT_RADIUS,
                FILM_SIZE[2],
                center,
                f"hole_edge_refinement{suffix}",
            ),
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
study.device(FMR_DEVICE, precision="double")
study.universe(
    mode="manual",
    size=AIRBOX_SIZE,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=AIRBOX_MIN_ELEMENT_SIZE,
    maximum_element_size=AIRBOX_MAX_ELEMENT_SIZE,
    growth_rate=AIRBOX_GROWTH_RATE,
    grading="linear",
)
study.objects.mesh.defaults(
    periodic_pair_ids=PERIODIC_PAIR_IDS,
    algorithm_2d=MESH_ALGORITHM_2D,
    algorithm_3d=MESH_ALGORITHM_3D,
    smoothing_steps=MESH_SMOOTHING_STEPS,
    optimize_iterations=MESH_OPTIMIZE_ITERATIONS,
    size_from_curvature=MESH_SIZE_FROM_CURVATURE,
    narrow_regions=MESH_NARROW_REGIONS,
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")

body = study.geometry(periodic_antidot_geometry(), name="periodic_film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
apply_periodic_airbox_mesh_policy(body)

study.b_ext(*APPLIED_B_T)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=DEMAG_SOLVER_RTOL,
    max_iterations=DEMAG_SOLVER_MAX_ITERATIONS,
)
if FROZEN_MAGNETIC_SUBMESH_SOURCE:
    study.frozen_magnetic_submesh(
        source=FROZEN_MAGNETIC_SUBMESH_SOURCE,
        region_markers={"periodic_film": 1},
        air_mesh_source=FROZEN_MAGNETIC_AIR_MESH_SOURCE or None,
    )
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)
study.tableautosave(1e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])

study.save("m", every=10e-12)
study.save_response("susceptibility_tensor")

if FMR_EQUILIBRIUM_SOURCE == "relax":
    study.stages.add_relax(
        algorithm="projected_gradient_bb",
        max_steps=RELAX_MAX_STEPS,
        tol=RELAX_TOL,
    )
study.stages.add_frequency_response(
    frequencies_hz=PROBE_FREQUENCIES_HZ,
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=True,
    equilibrium_source=FMR_EQUILIBRIUM_SOURCE,
    damping_policy="include",
    bc=PERIODIC_BC,
    magnetostatic_bc="periodic_airbox_k0",
)
