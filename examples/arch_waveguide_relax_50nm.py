"""FEM arch waveguide relaxation with perpendicular field and anisotropy.

Canonical executable example for the new ``ArchWaveguide`` geometry.

Usage:
    fullmag examples/arch_waveguide_relax_50nm.py
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

B_EXT_T = 0.0
RELAX_TORQUE_TOLERANCE_T = 1e-4
RELAX_TORQUE_TOLERANCE_APM = RELAX_TORQUE_TOLERANCE_T / MU0
G_FACTOR = 2.115
GAMMA = MU0 * G_FACTOR * MU_B / HBAR

MS = 7.7e5
AEX = 1e-11
ALPHA = 0.1
KU1 = 470e3
DIND = -1e-3
ANIS_U = (0.0, 0.0, 1.0)
DEMAG_PRINT_LEVEL = max(int(os.environ.get("FULLMAG_DEMAG_PRINT_LEVEL", "0")), 0)
ADAPTIVE_MAX_ERROR = 1e-4
ADAPTIVE_DT_MIN = float(os.environ.get("FULLMAG_ARCH_ADAPTIVE_DT_MIN", "1e-17"))

study = fm.study("arch_waveguide_relax_50nm")

# Engine
study.engine("fem")
study.device("cpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.visualization(active_quantity_id="h_eff")
study.airbox.visualization(show=True, mode="vectors")

study.universe(
    mode="auto",
    size=(4.0e-6, 2.2e-6, 5.5e-7),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
# minimum_element_size on universe = element size at the body-airbox interface.
# Must match body resolution (5nm ≈ lex) for a smooth transition.  Geometric
# grading then grows from 5nm → 150nm across the airbox depth.
study.universe.mesh(
    maximum_element_size=150e-9,
    minimum_element_size=5e-9,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# Geometry & material
# NOTE: arch_height=0 makes this effectively a flat rectangular body.
# ArchWaveguide creates 66 OCC loft faces for a flat shape, which causes
# algorithm_3d=1 (Delaunay) to fail in Gmsh 4.15. Use algorithm_3d=10 (HXT)
# directly to skip the failed attempt + fallback overhead.
waveguide = study.geometry(
    fm.ArchWaveguide(
        length=LENGTH,
        width=WIDTH,
        height=HEIGHT,
        arch_height=0e-9,
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
waveguide.dind = DIND
waveguide.m = fm.texture.uniform(0.4, 1e-4, 0.4)
waveguide.m = fm.texture.bloch_skyrmion(300e-9,40e-9,-1,1,"xy")
waveguide.visualization(show=True, mode="surface")
# waveguide.m = fm.texture.random(1)
# Exchange length lex = sqrt(2*Aex/(μ0·Ms²)) ≈ 5.2 nm.
# Uniform 5nm elements (≈ 1 lex) throughout the body is physically sufficient
# and gives ~4 elements through the 20nm thickness.
#
# object_core_relaxation is intentionally NOT used here because:
#   - STL → classifySurfaces(40°) creates ~31 artificial surface patches with
#     many false internal edges.  EdgeDistanceThreshold would refine around
#     every false edge, inflating the mesh by 3-5× for no physical benefit.
#   - For a 20nm thin film, surface_distance > thickness/4 puts the entire
#     interior in the "surface" zone, negating the core/surface split.
#   - Uniform 5nm = 1 lex is the correct resolution for this exchange length.
#
# algorithm_3d=10 (HXT) is the only reliable algorithm for lofted/imported
# surfaces in Gmsh 4.15 — avoids the Delaunay fallback overhead.
waveguide.mesh(
    maximum_element_size=5e-9,
    minimum_element_size=2e-9,
    order=1,
    algorithm_2d=6,
    algorithm_3d=10,
    smoothing_steps=4,
    optimize="Netgen",
    optimize_iterations=4,
    maximum_element_growth_rate=1.3,
    compute_quality=True,
    per_element_quality=False,
)
# Energy terms
study.b_ext(B_EXT_T, 0.0, 0.0)
study.demag(realization="poisson_robin")

# Demag solver tuning: rtol=1e-6 is sufficient for relaxation
# (max_torque[T] < 1e-4). The public RelaxStop threshold is in A/m.
# Keep interactive terminals quiet by default; set FULLMAG_DEMAG_PRINT_LEVEL=1
# to inspect per-solve Hypre/PCG convergence.
fm.fem_demag_solver(rtol=1e-6, max_iterations=1000, print_level=DEMAG_PRINT_LEVEL)

study.build_domain_mesh()

# Solver — max_error=1e-4 is adequate for relaxation where the physical
# convergence criterion (torque < tol) dominates over integrator accuracy.
study.solver(
    integrator="rk23",
    max_error=ADAPTIVE_MAX_ERROR,
    dt_min=ADAPTIVE_DT_MIN,
    gamma=GAMMA,
)

# Outputs
study.tableautosave(10e-12)
# study.save("m", every=250e-12)

# Stage
study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk23",
    max_error=ADAPTIVE_MAX_ERROR,
    dt_min=ADAPTIVE_DT_MIN,
    tol=RELAX_TORQUE_TOLERANCE_APM,
    max_steps=5000,
)
