"""Analytic check of the moment-weighted global average magnetization (note 0910).

Two regions of equal volume, Ms = 400 / 800 kA/m, with m = +x / -x. The
moment-weighted mean is <mx> = (400 - 800) / (400 + 800) = -1/3; an arithmetic
mean would give 0. Read ``mx`` from the step-0 row of ``artifacts/scalars.csv``.

Run inside the Docker DEV backend container::

    FDM_MEAN_DEVICE=gpu fullmag-bin scripts/benchmarks/fdm_moment_weighted_mean_case.py \
        --backend fdm --headless --json --output-dir /tmp/mean_gpu

FDM_MEAN_DEVICE  cpu | gpu (default cpu)
"""

import os

import fullmag as fm

DEVICE = os.environ.get("FDM_MEAN_DEVICE", "cpu").strip().lower()
CELL = 2e-9
NX, NY, NZ = 16, 4, 1
SIZE = (NX * CELL, NY * CELL, NZ * CELL)
DT = 1e-14

study = fm.study(f"fdm_moment_weighted_mean_{DEVICE}")
study.engine("fdm")
study.device(DEVICE, precision="double")
study.mode("strict")
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)

body = study.geometry(fm.Box(size=SIZE), name="film")
body.Ms = 400e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.two_domain(
    left=(1.0, 0.0, 0.0), right=(-1.0, 0.0, 0.0), wall=(0.0, 1.0, 0.0),
    normal_axis="x", sharp=True,
)
right = body.add_region(
    "right",
    fm.Box(size=(SIZE[0] / 2.0, SIZE[1], SIZE[2])).translate((SIZE[0] / 4.0, 0.0, 0.0)),
)
right.material.Ms = 800e3

study.demag(enabled=False)
study.solver(fix_dt=DT, integrator="rk4")
study.run(2 * DT)
