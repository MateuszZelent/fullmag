"""FEM CPU scaling benchmark — headless non-interactive execution.

This script creates a cylinder FEM problem (similar to STNO vortex MTJ) and
runs a relaxation stage. Stages execute automatically (no UI trigger needed).

The mesh resolution is controlled via the BENCH_HMAX environment variable
(in meters). Smaller hmax = more nodes = longer compute.

Usage:
    FULLMAG_CPU_THREADS=4 BENCH_HMAX=4e-9 fullmag --headless examples/bench_fem_cpu_scaling.py

The script prints timing information to stderr for analysis.
"""

import os
import sys
import time

import fullmag as fm

# ── Configuration from environment ──────────────────────────────────────

# Mesh resolution: smaller hmax = more nodes
HMAX = float(os.environ.get("BENCH_HMAX", "4e-9"))

# Number of relaxation steps (adjust for meaningful benchmark duration)
MAX_STEPS = int(os.environ.get("BENCH_MAX_STEPS", "500"))

# Cylinder dimensions
RADIUS = float(os.environ.get("BENCH_RADIUS", "50e-9"))
HEIGHT = float(os.environ.get("BENCH_HEIGHT", "9e-9"))

# Thread count (for logging only; actual control via FULLMAG_CPU_THREADS)
CPU_THREADS = os.environ.get("FULLMAG_CPU_THREADS", "auto")

# ── Problem setup ───────────────────────────────────────────────────────

print(f"[bench] FEM CPU scaling benchmark", file=sys.stderr)
print(f"[bench]   hmax          = {HMAX:.2e} m", file=sys.stderr)
print(f"[bench]   max_steps     = {MAX_STEPS}", file=sys.stderr)
print(f"[bench]   radius        = {RADIUS:.2e} m", file=sys.stderr)
print(f"[bench]   height        = {HEIGHT:.2e} m", file=sys.stderr)
print(f"[bench]   cpu_threads   = {CPU_THREADS}", file=sys.stderr)

setup_start = time.perf_counter()

study = fm.study("bench_fem_cpu_scaling")

# Engine: FEM on CPU with double precision
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(2.5e-7, 2.5e-7, 6e-8),
    center=(0, 0, 0),
    padding=(0, 0, 0),
    airbox_hmax=50e-9,
)
# NON-INTERACTIVE: stages auto-execute without UI trigger
study.interactive(False)

# Geometry: cylinder (free layer)
body = study.geometry(
    fm.Cylinder(radius=RADIUS, height=HEIGHT, name="free"),
    name="free",
)
body.Ms = 700_000       # A/m
body.Aex = 1.2e-11      # J/m
body.alpha = 0.01       # Gilbert damping
body.m = fm.uniform(1, 0, 0)  # Initial magnetization along +x  # type: ignore[assignment]
# External field
study.b_ext(0, 0, 0.02)  # 20 mT along z
