"""FDM region/material parity cases for the unbounded-region exchange operator.

Run inside the Docker DEV backend container, for example::

    FDM_REGIONS_CASE=two_materials FDM_REGIONS_DEVICE=gpu \
        fullmag-bin scripts/benchmarks/fdm_regions_parity_case.py \
        --backend fdm --headless --json --output-dir /tmp/regions/two_gpu

``scripts/benchmarks/run_fdm_regions_parity.py`` drives CPU and CUDA runs of
every case and compares the final magnetization and energies. Environment
knobs (all optional):

FDM_REGIONS_CASE       two_materials | two_materials_scaled | grains | uniform |
                       uniform_regions                          (default two_materials)
FDM_REGIONS_DEVICE     cpu | gpu                                 (default cpu)
FDM_REGIONS_PRECISION  double | single                           (default double)
FDM_REGIONS_STEPS      fixed-dt step count                       (default 2000)
FDM_REGIONS_GRAINS     grains per axis for the grains case        (default 32,32)
FDM_REGIONS_DEMAG      1 = demag on                              (default 1)
FDM_REGIONS_SAVE_FIELDS 1 = also save H_ex and H_eff at the end  (default 0)
"""

import os
import random

import fullmag as fm


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


CASE = _env("FDM_REGIONS_CASE", "two_materials").lower()
DEVICE = _env("FDM_REGIONS_DEVICE", "cpu").lower()
PRECISION = _env("FDM_REGIONS_PRECISION", "double").lower()
STEPS = int(_env("FDM_REGIONS_STEPS", "2000"))
GRAINS_X, GRAINS_Y = (int(v) for v in _env("FDM_REGIONS_GRAINS", "32,32").split(","))
DEMAG = _env("FDM_REGIONS_DEMAG", "1") == "1"
SAVE_FIELDS = _env("FDM_REGIONS_SAVE_FIELDS", "0") == "1"
CELL = 2e-9
DT = 1e-14

if CASE.startswith("two_materials") or CASE.startswith("uniform"):
    NX, NY, NZ = 128, 32, 1
else:
    NX, NY, NZ = GRAINS_X * 8, GRAINS_Y * 8, 1
SIZE = (NX * CELL, NY * CELL, NZ * CELL)

study = fm.study(f"fdm_regions_{CASE}_{DEVICE}_{PRECISION}")
study.engine("fdm")
study.device(DEVICE, precision=PRECISION)
study.mode("strict")
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)

body = study.geometry(fm.Box(size=SIZE), name="film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.random(seed=11)


def _half(name: str, sign: float):
    return body.add_region(
        name,
        fm.Box(size=(SIZE[0] / 2.0, SIZE[1], SIZE[2])).translate((sign * SIZE[0] / 4.0, 0.0, 0.0)),
    )


if CASE in ("two_materials", "two_materials_scaled"):
    left = _half("left", -1.0)
    right = _half("right", 1.0)
    right.material.Ms = 1.2e6
    right.material.Aex = 20e-12
    right.material.alpha = 0.1
    if CASE == "two_materials":
        study.couplings.exchange(left, right, mode="explicit", inter_exchange=4e-12)
    else:
        study.couplings.exchange(left, right, mode="harmonic_mean", scale=0.5)
elif CASE == "uniform_regions":
    _half("left", -1.0)
    _half("right", 1.0)
elif CASE == "grains":
    rng = random.Random(1234)
    width, height = SIZE[0] / GRAINS_X, SIZE[1] / GRAINS_Y
    grains = []
    for gy in range(GRAINS_Y):
        for gx in range(GRAINS_X):
            x0 = -SIZE[0] / 2.0 + (gx + 0.5) * width
            y0 = -SIZE[1] / 2.0 + (gy + 0.5) * height
            # Neighbouring grains share faces; distinct priorities decide the
            # shared boundary samples deterministically.
            grain = body.add_region(
                f"grain_{gy:03d}_{gx:03d}",
                fm.Box(size=(width, height, SIZE[2])).translate((x0, y0, 0.0)),
                priority=gy * GRAINS_X + gx,
            )
            grain.material.Ms = 800e3 * rng.uniform(0.9, 1.1)
            grain.material.Aex = 13e-12 * rng.uniform(0.9, 1.1)
            grain.material.alpha = 0.02 * rng.uniform(0.9, 1.1)
            grains.append(grain)
    # A few explicit grain-boundary rules on top of the harmonic default.
    for index in range(0, len(grains) - 1, 97):
        study.couplings.exchange(grains[index], grains[index + 1], mode="harmonic_mean", scale=0.3)
elif CASE != "uniform":
    raise ValueError(f"unknown FDM_REGIONS_CASE={CASE}")

study.demag(enabled=DEMAG)
study.b_ext(0.0, 0.0, 50e-3)
if SAVE_FIELDS:
    for quantity in ("H_ex", "H_eff"):
        study.save(quantity, every=STEPS * DT)
study.solver(fix_dt=DT, integrator="rk4")
study.run(STEPS * DT)
