"""Simple single-run FEM benchmark for profiling.

Runs a non-interactive relaxation stage and prints step-by-step timing emitted
by the native runner. Use this for `htop`, `perf`, or flamegraph sessions.

Usage:
    FULLMAG_CPU_THREADS=auto fullmag --headless examples/bench_fem_simple.py
"""

import os
import sys
import time

import fullmag as fm

HMAX = float(os.environ.get("BENCH_HMAX", "3e-9"))
MAX_STEPS = int(os.environ.get("BENCH_MAX_STEPS", "200"))
THREADS = os.environ.get("FULLMAG_CPU_THREADS", "auto")

print("", file=sys.stderr)
print("┌──────────────────────────────────────────────────────────────┐", file=sys.stderr)
print("│  FEM CPU Benchmark - Simple Profiling Run                   │", file=sys.stderr)
print("├──────────────────────────────────────────────────────────────┤", file=sys.stderr)
print(f"│  hmax       = {HMAX:.2e} m", file=sys.stderr)
print(f"│  max_steps  = {MAX_STEPS}", file=sys.stderr)
print(f"│  threads.request = {THREADS}", file=sys.stderr)
print("│  threads.resolve = see [fullmag-fem] cpu runtime log", file=sys.stderr)
print("└──────────────────────────────────────────────────────────────┘", file=sys.stderr)
print("", file=sys.stderr)

t0 = time.perf_counter()

study = fm.study("bench_fem_simple")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(2.5e-7, 2.5e-7, 6e-8),
    center=(0, 0, 0),
    airbox_hmax=50e-9,
)
study.interactive(False)

body = study.geometry(
    fm.Cylinder(radius=50e-9, height=9e-9, name="layer"),
    name="layer",
)
body.Ms = 700_000
body.Aex = 1.2e-11
body.alpha = 0.01
body.m = fm.random(seed=11)  # type: ignore[assignment]

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

setup_time = time.perf_counter() - t0
print(f"[bench] Setup complete in {setup_time:.2f}s", file=sys.stderr)
print(f"[bench] Starting relaxation ({MAX_STEPS} steps)...", file=sys.stderr)
