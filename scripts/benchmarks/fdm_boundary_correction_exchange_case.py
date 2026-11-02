"""Analytic exchange cases for the FDM CUDA boundary-correction tiers (note 0550).

``aligned``: a disk two cells tall whose top and bottom faces lie on cell faces,
with a helix along z. Away from the rim H_ex is the z coupling between the two
layers only; the exact Neumann result there equals the clamped (T0/none)
stencil, so H_ex(T1) / H_ex(T0) must be 1.

``partial``: a disk 1.25 cells tall, so rim cells of the upper layer have
0 < phi < phi_floor (the energy-density check itself runs through the C ABI in
``fdm_cuda_analytic_abi_checks.py``; ``eden_ex`` is not a saved field output).

Run inside the Docker DEV backend container::

    FDM_BC_CASE=aligned FDM_BC_MODE=full fullmag-bin \
        scripts/benchmarks/fdm_boundary_correction_exchange_case.py \
        --backend fdm --headless --json --output-dir /tmp/bc_full

FDM_BC_CASE  aligned | partial          (default aligned)
FDM_BC_MODE  none | volume | full       (default volume)
"""

import os

import fullmag as fm

CASE = os.environ.get("FDM_BC_CASE", "aligned").strip().lower()
MODE = os.environ.get("FDM_BC_MODE", "volume").strip().lower()
CELL = 2e-9
NX = NY = 16
NZ = 2
SIZE = (NX * CELL, NY * CELL, NZ * CELL)
RADIUS = 6.0 * CELL
HEIGHT = NZ * CELL if CASE == "aligned" else 1.25 * CELL
DT = 1e-15

study = fm.study(f"fdm_bc_exchange_{CASE}_{MODE}")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)
study.boundary_correction(MODE)

disk = fm.Cylinder(radius=RADIUS, height=HEIGHT)
if CASE == "partial":
    # Bottom face on the lower grid face, top face a quarter into the upper layer.
    disk = disk.translate((0.0, 0.0, (HEIGHT - SIZE[2]) / 2.0))
body = study.geometry(disk, name="disk")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.helical(wavevector=(0.0, 0.0, 3.0e8))

study.demag(enabled=False)
study.save("H_ex", every=DT)
study.solver(fix_dt=DT, integrator="rk4")
study.run(DT)
