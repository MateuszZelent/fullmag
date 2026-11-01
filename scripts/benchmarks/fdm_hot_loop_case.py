"""Parameterised FDM hot-loop benchmark case (CPU and CUDA lanes).

Run inside the Docker DEV backend container, for example::

    FDM_BENCH_DEVICE=cpu FDM_BENCH_GRID=256,256,8 \
        fullmag-bin scripts/benchmarks/fdm_hot_loop_case.py \
        --backend fdm --headless --json --output-dir /build/fdm-bench/case

``scripts/benchmarks/run_fdm_hot_loop_bench.py`` drives a matrix of these
cases and records wall time.  Environment knobs (all optional):

FDM_BENCH_DEVICE       cpu | gpu                         (default cpu)
FDM_BENCH_GRID         nx,ny,nz cell counts              (default 128,128,8)
FDM_BENCH_CELL         cell edge in metres               (default 4e-9)
FDM_BENCH_STEPS        fixed-dt step count               (default 200)
FDM_BENCH_INTEGRATOR   heun | rk4 | rk23 | rk45          (default heun)
FDM_BENCH_ADAPTIVE     1 = adaptive dt (rk23/rk45 only)  (default 0)
FDM_BENCH_DEMAG        1 = demag on                      (default 1)
FDM_BENCH_HETERO       1 = region with its own Ms (spatial Ms, forces CPU AoS)
FDM_BENCH_REGIONS      N >= 2 = N object regions as x stripes (CUDA LUT path)
FDM_BENCH_THREADS      CPU thread count (default: runtime default)

The magnetic state is a deterministic random texture, so the exchange and
demag fields are non-trivial from the first step.
"""

import os

import fullmag as fm


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


DEVICE = _env("FDM_BENCH_DEVICE", "cpu").lower()
NX, NY, NZ = (int(v) for v in _env("FDM_BENCH_GRID", "128,128,8").split(","))
CELL = float(_env("FDM_BENCH_CELL", "4e-9"))
STEPS = int(_env("FDM_BENCH_STEPS", "200"))
INTEGRATOR = _env("FDM_BENCH_INTEGRATOR", "heun").lower()
ADAPTIVE = _env("FDM_BENCH_ADAPTIVE", "0") == "1"
DEMAG = _env("FDM_BENCH_DEMAG", "1") == "1"
HETERO = _env("FDM_BENCH_HETERO", "0") == "1"
REGIONS = int(_env("FDM_BENCH_REGIONS", "0"))
THREADS = _env("FDM_BENCH_THREADS", "")
DT = 1e-13

SIZE = (NX * CELL, NY * CELL, NZ * CELL)

study = fm.study(f"fdm_hot_loop_{DEVICE}_{NX}x{NY}x{NZ}")
study.engine("fdm")
study.device(DEVICE, precision="double")
study.mode("strict")
if THREADS:
    study.threads(int(THREADS))
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)


def _material(body, ms: float) -> None:
    body.Ms = ms
    body.Aex = 13e-12
    body.alpha = 0.02
    body.m = fm.texture.random(seed=7)


body = study.geometry(fm.Box(size=SIZE), name="film")
_material(body, 800e3)
if HETERO:
    # A region with its own Ms gives the single grid a spatial Ms(r), which
    # keeps the CPU lane on the AoS path.
    half = body.add_region(
        "right_half",
        fm.Box(size=(SIZE[0] / 2.0, SIZE[1], SIZE[2])).translate((SIZE[0] / 4.0, 0.0, 0.0)),
    )
    half.material.Ms = 600e3
elif REGIONS >= 2:
    width = SIZE[0] / REGIONS
    for index in range(REGIONS):
        x0 = -SIZE[0] / 2.0 + (index + 0.5) * width
        body.add_region(
            f"stripe_{index}",
            fm.Box(size=(width, SIZE[1], SIZE[2])).translate((x0, 0.0, 0.0)),
        )

# Demag is on by default in the flat API, so it is set explicitly either way.
study.demag(enabled=DEMAG)
study.b_ext(0.0, 0.0, 10e-3)

if ADAPTIVE:
    study.solver(integrator=INTEGRATOR, dt_initial=DT, max_err=1e-5, dt_max=1e-12)
else:
    study.solver(fix_dt=DT, integrator=INTEGRATOR)

study.run(STEPS * DT)
