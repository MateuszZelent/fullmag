"""Clean FEM CPU benchmark entrypoint.

This is a minimal, non-interactive version of the CPU scaling benchmark. It
shares the same problem definition as `bench_fem_cpu_scaling.py` but keeps the
file intentionally compact for quick smoke runs.

Usage:
    FULLMAG_CPU_THREADS=auto BENCH_HMAX=4e-9 fullmag --headless examples/bench_fem_clean.py
"""

import os
import sys
import time

import fullmag as fm

HMAX = float(os.environ.get("BENCH_HMAX", "4e-9"))
MAX_STEPS = int(os.environ.get("BENCH_MAX_STEPS", "200"))
RADIUS = float(os.environ.get("BENCH_RADIUS", "50e-9"))
HEIGHT = float(os.environ.get("BENCH_HEIGHT", "9e-9"))
GEOMETRY = os.environ.get("BENCH_GEOMETRY", "cylinder").strip().lower()
KU1 = float(os.environ.get("BENCH_KU1", "0.0"))
DEMAG_SOLVER = os.environ.get("BENCH_DEMAG_SOLVER", "CG").strip().upper()
DEMAG_PRECONDITIONER = os.environ.get("BENCH_DEMAG_PRECONDITIONER", "AMG").strip().upper()
DEMAG_RTOL = float(os.environ.get("BENCH_DEMAG_RTOL", "1e-8"))
DEMAG_ATOL_RAW = os.environ.get("BENCH_DEMAG_ATOL", "").strip()
DEMAG_ATOL = float(DEMAG_ATOL_RAW) if DEMAG_ATOL_RAW else None
DEMAG_MAX_ITERATIONS = int(os.environ.get("BENCH_DEMAG_MAX_ITERATIONS", "500"))
DEMAG_PRINT_LEVEL = int(os.environ.get("BENCH_DEMAG_PRINT_LEVEL", "0"))
CPU_THREADS = os.environ.get("FULLMAG_CPU_THREADS", "auto")

print("[bench] FEM CPU clean benchmark", file=sys.stderr)
print(f"[bench]   maximum element size = {HMAX:.2e} m", file=sys.stderr)
print(f"[bench]   max_steps     = {MAX_STEPS}", file=sys.stderr)
print(f"[bench]   radius        = {RADIUS:.2e} m", file=sys.stderr)
print(f"[bench]   height        = {HEIGHT:.2e} m", file=sys.stderr)
print(f"[bench]   geometry      = {GEOMETRY}", file=sys.stderr)
print(f"[bench]   Ku1           = {KU1:.2e} J/m^3", file=sys.stderr)
print(f"[bench]   demag_solver  = {DEMAG_SOLVER}/{DEMAG_PRECONDITIONER}", file=sys.stderr)
print(f"[bench]   demag_rtol    = {DEMAG_RTOL:.2e}", file=sys.stderr)
print(f"[bench]   demag_atol    = {DEMAG_ATOL}", file=sys.stderr)
print(f"[bench]   demag_max_it  = {DEMAG_MAX_ITERATIONS}", file=sys.stderr)
print(f"[bench]   cpu_threads.request = {CPU_THREADS}", file=sys.stderr)
print("[bench]   cpu_threads.resolve = see [fullmag-fem] cpu runtime log", file=sys.stderr)

setup_start = time.perf_counter()

study = fm.study("bench_fem_clean")
study.engine("fem")
study.device("cpu", precision="double")
study.fem_demag_solver(
    solver=DEMAG_SOLVER,
    preconditioner=DEMAG_PRECONDITIONER,
    rtol=DEMAG_RTOL,
    atol=DEMAG_ATOL,
    max_iterations=DEMAG_MAX_ITERATIONS,
    print_level=DEMAG_PRINT_LEVEL,
)
study.universe(
    mode="auto",
    size=(2.5e-7, 2.5e-7, 6e-8),
    center=(0, 0, 0),
    padding=(0, 0, 0),
)
study.universe.mesh(maximum_element_size=50e-9)
study.interactive(False)

if GEOMETRY == "box":
    geometry = fm.Box(size=(2.0 * RADIUS, 2.0 * RADIUS, HEIGHT), name="free")
elif GEOMETRY == "cylinder":
    geometry = fm.Cylinder(radius=RADIUS, height=HEIGHT, name="free")
else:
    raise ValueError("BENCH_GEOMETRY must be 'cylinder' or 'box'")

body = study.geometry(geometry, name="free")
body.Ms = 700_000
body.Aex = 1.2e-11
body.alpha = 0.01
if KU1 > 0.0:
    body.Ku1 = KU1
    body.anisU = (0.0, 0.0, 1.0)
body.m = fm.texture.random(seed=11)  # type: ignore[assignment]

study.b_ext(0, 0, 0.02)
study.demag(realization="poisson_robin")

body.mesh(
    maximum_element_size=HMAX,
    order=1,
    algorithm_2d=8,
    algorithm_3d=1,
    size_from_curvature=1,
)
study.build_domain_mesh()

study.solver(integrator="rk23", max_error=1e-6, gamma=233728.481992)
study.stages.add_relax(max_steps=MAX_STEPS, tolA=1e-8, algorithm="llg_overdamped")

setup_time = time.perf_counter() - setup_start
print(f"[bench] Setup complete in {setup_time:.2f}s", file=sys.stderr)
print(f"[bench] Starting relaxation ({MAX_STEPS} steps)...", file=sys.stderr)
