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

LENGTH = 2500e-9
WIDTH = 1000e-9
HEIGHT = 40e-9
AIRBOX_Z = 500e-9
AIRBOX_HMAX = 500e-9
AIRBOX_HMIN = 20e-9

WAVEGUIDE_BULK_HMAX = 20e-9
WAVEGUIDE_LOCAL_HMAX = 12e-9
WAVEGUIDE_HMIN = 5e-9
AIRBOX_NEAR_INTERFACE_HMAX = 40e-9
AIRBOX_NEAR_INTERFACE_THICKNESS = 20e-9
AIRBOX_TRANSITION_DISTANCE = 120e-9
AIRBOX_EDGE_HMAX = WAVEGUIDE_BULK_HMAX
AIRBOX_EDGE_THICKNESS = WAVEGUIDE_BULK_HMAX
AIRBOX_EDGE_TRANSITION_DISTANCE = 60e-9
AIRBOX_CORNER_TRANSITION_DISTANCE = 40e-9

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
study.device("gpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.visualization(active_quantity_id="h_eff")
study.airbox.visualization(show=True, mode="vectors")

study.universe(
    mode="auto",
    size=(3500e-9, 2000e-9, AIRBOX_Z),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
# Airbox sizing only: coarse far-field domain.  The magnetic body resolution is
# declared below on waveguide.mesh(...) and must not inherit these air sizes.
study.universe.mesh(
    maximum_element_size=AIRBOX_HMAX,
    minimum_element_size=AIRBOX_HMIN,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# Shared-domain Gmsh controls.  These are global because one conforming mesh is
# generated for body + airbox; per-object settings below only control sizing.
study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    maximum_element_growth_rate=1.3,
    compute_quality=True,
    per_element_quality=False,
)

# Geometry & material
# NOTE: arch_height=0 makes this effectively a flat rectangular body. The OCC
# lowering uses a native box for this flat case, so Delaunay stays available.
waveguide = study.geometry(
    fm.ArchWaveguide(
        length=LENGTH,
        width=WIDTH,
        height=HEIGHT,
        arch_height=0e-9,
        z0=0,
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
waveguide.m = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")
waveguide.visualization(show=True, mode="surface")
# waveguide.m = fm.texture.random(1)
# Exchange length lex = sqrt(2*Aex/(μ0·Ms²)) ≈ 5.2 nm.
# Interactive preset: keep the magnetic body much finer than the far-field
# airbox without making the full 2.5 um x 1.0 um sheet a 2 nm surface mesh.
# A 5 nm / 2 nm production preset passes mesh validation but creates about
# 2.35M tetrahedra here and is too slow as the default interactive example.
# The interface/transition controls are COMSOL-style automatic sizing fields:
# keep air moderately resolved near the magnetic surface, then grade smoothly
# to the coarse far-field airbox target without hand-drawing airbox boxes.
waveguide.mesh.thin_film(
    maximum_element_size=WAVEGUIDE_BULK_HMAX,
    minimum_element_size=WAVEGUIDE_HMIN,
    interface_maximum_element_size=AIRBOX_NEAR_INTERFACE_HMAX,
    interface_thickness=AIRBOX_NEAR_INTERFACE_THICKNESS,
    transition_distance=AIRBOX_TRANSITION_DISTANCE,
    edge_maximum_element_size=AIRBOX_EDGE_HMAX,
    edge_thickness=AIRBOX_EDGE_THICKNESS,
    edge_transition_distance=AIRBOX_EDGE_TRANSITION_DISTANCE,
    corner_maximum_element_size=AIRBOX_EDGE_HMAX,
    corner_extent=AIRBOX_EDGE_THICKNESS,
    corner_transition_distance=AIRBOX_CORNER_TRANSITION_DISTANCE,
    layers=1,
    order=1,
)
waveguide.mesh.size_field(
    "ComponentRestrictedCylinder",
    GeometryName="arch_waveguide_geom",
    VIn=WAVEGUIDE_LOCAL_HMAX,
    VOut=WAVEGUIDE_BULK_HMAX,
    Radius=500e-9,
    XCenter=0.0,
    YCenter=0.0,
    ZCenter=0.0,
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
