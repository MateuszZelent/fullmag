"""FEM Permalloy film relaxation benchmark.

Rectangular 1000 x 500 x 10 nm Permalloy film with in-plane 0.1 T field along
the long axis. Intended for native FEM/MFEM demag profiling.

Usage:
    fullmag --headless examples/permalloy_film_relax_1000x500x10nm.py
"""

from __future__ import annotations

import os
import sys
import time

import fullmag as fm


MU0 = 1.2566e-6
MU_B = 9.274e-24
HBAR = 1.054_571_817e-34

LENGTH = 1000e-9
WIDTH = 500e-9
THICKNESS = 10e-9

MS = 800e3
AEX = 13e-12
ALPHA = 0.02
B_EXT_T = 0.1
G_FACTOR = 2.115
GAMMA = MU0 * G_FACTOR * MU_B / HBAR

MAX_STEPS = int(os.environ.get("PERMALLOY_MAX_STEPS", "100"))
OBJECT_HMAX = float(os.environ.get("PERMALLOY_OBJECT_HMAX", "10e-9"))
AIR_HMAX = float(os.environ.get("PERMALLOY_AIR_HMAX", "120e-9"))
AIR_HMIN = float(os.environ.get("PERMALLOY_AIR_HMIN", "30e-9"))
DEVICE = os.environ.get("PERMALLOY_DEVICE", "cpu")
CPU_THREADS = os.environ.get("FULLMAG_CPU_THREADS")
DEMAG_PRINT_LEVEL = max(int(os.environ.get("FULLMAG_DEMAG_PRINT_LEVEL", "0")), 0)

print("[permalloy] FEM film relaxation benchmark", file=sys.stderr)
print(f"[permalloy]   film_size = {LENGTH:.3e} x {WIDTH:.3e} x {THICKNESS:.3e} m", file=sys.stderr)
print(f"[permalloy]   object_hmax = {OBJECT_HMAX:.3e} m", file=sys.stderr)
print("[permalloy]   through_thickness_elements = 1", file=sys.stderr)
print(f"[permalloy]   air_hmax = {AIR_HMAX:.3e} m", file=sys.stderr)
print(f"[permalloy]   B_ext = ({B_EXT_T:.3e}, 0, 0) T", file=sys.stderr)
print(f"[permalloy]   max_steps = {MAX_STEPS}", file=sys.stderr)
print(f"[permalloy]   requested_device = {DEVICE}", file=sys.stderr)
if CPU_THREADS:
    print(f"[permalloy]   cpu_threads.request = {CPU_THREADS}", file=sys.stderr)

setup_start = time.perf_counter()

study = fm.study("permalloy_film_relax_1000x500x10nm")
study.engine("fem")
study.device(DEVICE, precision="double")
study.interactive(False)
if CPU_THREADS and CPU_THREADS.isdigit():
    study.threads(int(CPU_THREADS))

study.universe(
    mode="auto",
    size=(2.2e-6, 1.2e-6, 4.0e-7),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=AIR_HMAX,
    minimum_element_size=AIR_HMIN,
    maximum_element_growth_rate=2.0,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(LENGTH, WIDTH, THICKNESS), name="permalloy_film"),
    name="permalloy_film",
)
film.Ms = MS
film.Aex = AEX
film.alpha = ALPHA
film.m = fm.texture.uniform(1.0, 1e-4, 0.0)
film.mesh(
    maximum_element_size=OBJECT_HMAX,
    minimum_element_size=OBJECT_HMAX,
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
    size_from_curvature=1,
    smoothing_steps=4,
    optimize="Netgen",
    optimize_iterations=4,
    maximum_element_growth_rate=1.2,
    compute_quality=True,
)

study.b_ext(B_EXT_T, 0.0, 0.0)
study.demag(realization="poisson_robin")
fm.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-6,
    max_iterations=200,
    print_level=DEMAG_PRINT_LEVEL,
)

study.build_domain_mesh()
study.solver(integrator="rk23", max_error=1e-4, gamma=GAMMA)
study.tableautosave(10e-12)
study.stages.add_relax(
    algorithm="llg_overdamped",
    tolA=1e-4,
    max_steps=MAX_STEPS,
)

setup_time = time.perf_counter() - setup_start
print(f"[permalloy] Setup complete in {setup_time:.2f}s", file=sys.stderr)
