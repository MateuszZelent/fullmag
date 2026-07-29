"""FEM arch-waveguide skyrmion relaxation on the shared-domain mesh.

Usage:
    fullmag examples/arch_skyrmion_relax_50nm.py --headless
"""

from __future__ import annotations

import os

import fullmag as fm


MU0 = 1.2566e-6
MU_B = 9.274e-24
HBAR = 1.054_571_817e-34

LENGTH = 2.5e-6
WIDTH = 1.0e-6
HEIGHT = 20e-9
ARCH_HEIGHT = 50e-9
Z0 = -ARCH_HEIGHT / 2.0

B_EXT_T = 1e-7
RELAX_TORQUE_TOLERANCE_T = 1e-4
RELAX_TORQUE_TOLERANCE_APM = RELAX_TORQUE_TOLERANCE_T / MU0
G_FACTOR = 2.115
GAMMA = MU0 * G_FACTOR * MU_B / HBAR

MS = 956e3
AEX = 10e-12
ALPHA = 0.1
KU1 = 0.8e6
ANIS_U = (0.0, 0.0, 1.0)
SKYRMION_RADIUS = float(os.environ.get("FULLMAG_ARCH_SKYRMION_RADIUS", "120e-9"))
SKYRMION_WALL_WIDTH = float(os.environ.get("FULLMAG_ARCH_SKYRMION_WALL_WIDTH", "25e-9"))
DEMAG_PRINT_LEVEL = max(int(os.environ.get("FULLMAG_DEMAG_PRINT_LEVEL", "0")), 0)
ADAPTIVE_MAX_ERROR = 1e-4
ADAPTIVE_DT_MIN = float(os.environ.get("FULLMAG_ARCH_ADAPTIVE_DT_MIN", "1e-17"))
ADAPTIVE_DT_MAX = 1e-14

study = fm.study("arch_skyrmion_relax_50nm")

study.engine("fem")
study.device("cuda:0", precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(
    mode="auto",
    size=(4.0e-6, 2.2e-6, 5.5e-7),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=200e-9,
    minimum_element_size=20e-9,
    maximum_element_growth_rate=2.5,
    grading="geometric",
)

waveguide = study.geometry(
    fm.ArchWaveguide(
        length=LENGTH,
        width=WIDTH,
        height=HEIGHT,
        arch_height=ARCH_HEIGHT,
        z0=Z0,
        name="arch_waveguide",
    ),
    name="arch_waveguide",
)
waveguide.Ms = MS
waveguide.Aex = AEX
waveguide.alpha = ALPHA
waveguide.Ku1 = KU1
waveguide.anisU = ANIS_U
waveguide.m = fm.texture.neel_skyrmion(
    radius=SKYRMION_RADIUS,
    wall_width=SKYRMION_WALL_WIDTH,
    chirality=1,
    core_polarity=-1,
)
waveguide.mesh(
    maximum_element_size=6e-9,
    minimum_element_size=1.8e-9,
    transition_distance=80e-9,
    mesh_strategy="swept_prism",
    topology="prismatic",
    through_thickness_elements=1,
    through_thickness_distribution="fixed",
    sweep_face_meshing="triangular",
    sweep_direction="auto",
    element_family="prism",
    transition_policy="pyramid_to_tetrahedra",
    exact_layer_count=True,
    order=1,
    algorithm_2d=6,
    algorithm_3d=1,
    size_from_curvature=16,
    smoothing_steps=8,
    optimize="Netgen",
    optimize_iterations=8,
    curvature_factor=0.35,
    maximum_element_growth_rate=1.22,
    narrow_regions=2,
    narrow_region_resolution=1.0,
    transition_growth=1.18,
    compute_quality=True,
    per_element_quality=True,
)
core_relaxation = fm.mesh.object_core_relaxation(
    "arch_waveguide",
    maximum_element_size=6e-9,
    surface_maximum_element_size=2e-9,
    surface_distance=80e-9,
    edge_maximum_element_size=1.8e-9,
    edge_distance=50e-9,
)
waveguide.mesh.size_field(core_relaxation["kind"], **core_relaxation["params"])

study.b_ext(0.0, 0.0, B_EXT_T)
study.demag(realization="poisson_robin")
fm.fem_demag_solver(rtol=1e-6, max_iterations=200, print_level=DEMAG_PRINT_LEVEL)

study.build_domain_mesh()

study.solver(
    integrator="rk45",
    max_error=ADAPTIVE_MAX_ERROR,
    dt_min=ADAPTIVE_DT_MIN,
    dt_max=ADAPTIVE_DT_MAX,
    gamma=GAMMA,
)

study.tableautosave(10e-12)
study.save("m", every=250e-12)

study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk45",
    max_error=ADAPTIVE_MAX_ERROR,
    dt_min=ADAPTIVE_DT_MIN,
    dt_max=ADAPTIVE_DT_MAX,
    tol=RELAX_TORQUE_TOLERANCE_APM,
    max_steps=5000,
)
