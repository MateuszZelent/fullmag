"""FEM arch waveguide relaxation with perpendicular field and anisotropy.

Canonical executable example for the new ``ArchWaveguide`` geometry.

Usage:
    fullmag examples/arch_waveguide_relax_50nm.py
"""

from __future__ import annotations

import fullmag as fm


MU0 = 1.2566e-6
MU_B = 9.274e-24
HBAR = 1.054_571_817e-34

LENGTH = 2.5e-6
WIDTH = 1.0e-6
HEIGHT = 2e-9
ARCH_HEIGHT = 50e-9
Z0 = -ARCH_HEIGHT / 2.0

B_EXT_T = 1e-7
G_FACTOR = 2.115
GAMMA = MU0 * G_FACTOR * MU_B / HBAR

MS = 956e3
AEX = 10e-12
ALPHA = 0.1
KU1 = 0.8e6
ANIS_U = (0.0, 0.0, 1.0)

study = fm.study("arch_waveguide_relax_50nm")

# Engine
study.engine("fem")
study.device("cpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(
    mode="auto",
    size=(3.0e-6, 1.2e-6, 2.5e-7),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=100e-9,
    minimum_element_size=50e-9,
    growth_rate=1.25,
    grading="geometric",
)

# Geometry & material
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
waveguide.m = fm.texture.uniform(0.0, 0.0, 1.0)
waveguide.mesh(
    maximum_element_size=50e-9,
    minimum_element_size=25e-9,
    order=1,
    algorithm_2d=6,
    algorithm_3d=1,
    size_from_curvature=24,
    smoothing_steps=5,
    optimize="Netgen",
    optimize_iterations=5,
    curvature_factor=0.6,
    maximum_element_growth_rate=1.2,
    narrow_regions=4,
    narrow_region_resolution=1.0,
    interface_hmax=20e-9,
    interface_thickness=6e-9,
    transition_distance=60e-9,
    transition_growth=1.25,
    compute_quality=True,
    per_element_quality=True,
)

# Energy terms
study.b_ext(0.0, 0.0, B_EXT_T)
study.demag(realization="poisson_robin")
study.build_domain_mesh()

# Solver
study.solver(integrator="rk45", max_error=1e-6, gamma=GAMMA)

# Outputs
study.tableautosave(10e-12)
study.save("m", every=250e-12)

# Stage
study.stages.add_relax(
    algorithm="llg_overdamped",
    tol=1e-4,
    max_steps=5000,
)
