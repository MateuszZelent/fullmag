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
CPU_THREADS = os.environ.get("FULLMAG_CPU_THREADS", "auto")

print("[bench] FEM CPU clean benchmark", file=sys.stderr)
print(f"[bench]   hmax          = {HMAX:.2e} m", file=sys.stderr)
print(f"[bench]   max_steps     = {MAX_STEPS}", file=sys.stderr)
print(f"[bench]   radius        = {RADIUS:.2e} m", file=sys.stderr)
print(f"[bench]   height        = {HEIGHT:.2e} m", file=sys.stderr)
print(f"[bench]   cpu_threads.request = {CPU_THREADS}", file=sys.stderr)
print("[bench]   cpu_threads.resolve = see [fullmag-fem] cpu runtime log", file=sys.stderr)

setup_start = time.perf_counter()

study = fm.study("bench_fem_clean")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(2.5e-7, 2.5e-7, 6e-8),
    center=(0, 0, 0),
    padding=(0, 0, 0),
)
study.universe.mesh(maximum_element_size=50e-9)
study.interactive(False)

body = study.geometry(
    fm.Cylinder(radius=RADIUS, height=HEIGHT, name="free"),
    name="free",
)
body.Ms = 700_000
body.Aex = 1.2e-11
body.alpha = 0.01
body.m = fm.texture.random_seeded(seed=11)  # type: ignore[assignment]

study.b_ext(0, 0, 0.02)
study.demag(realization="poisson_robin")

body.mesh(
    hmax=HMAX,
    order=1,
    algorithm_2d=8,
    algorithm_3d=1,
    size_from_curvature=1,
)
study.build_domain_mesh()

study.solver(integrator="rk23", max_error=1e-6, gamma=233728.481992)
study.stages.add_relax(max_steps=MAX_STEPS, tol=1e-8, algorithm="llg_overdamped")

setup_time = time.perf_counter() - setup_start
print(f"[bench] Setup complete in {setup_time:.2f}s", file=sys.stderr)
print(f"[bench] Starting relaxation ({MAX_STEPS} steps)...", file=sys.stderr)
