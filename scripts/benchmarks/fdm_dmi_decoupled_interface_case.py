"""DMI across a decoupled exchange interface must be rejected (note 0104).

``bodies``: two touching boxes that are separate objects; exchange does not
couple them. ``disabled``: one body with two regions and a Disabled exchange
rule (an explicit zero inter-region stiffness). ``scaled``: the same regions with a harmonic-mean scale of 0.5, which
keeps the connection and must still run. All cases enable interfacial DMI.

Run inside the Docker DEV backend container::

    FDM_DMI_CASE=bodies FDM_DMI_DEVICE=gpu fullmag-bin \
        scripts/benchmarks/fdm_dmi_decoupled_interface_case.py \
        --backend fdm --headless --json --output-dir /tmp/dmi_bodies_gpu

FDM_DMI_CASE    bodies | disabled | scaled    (default bodies)
FDM_DMI_DEVICE  cpu | gpu                     (default cpu)
"""

import os

import fullmag as fm

CASE = os.environ.get("FDM_DMI_CASE", "bodies").strip().lower()
DEVICE = os.environ.get("FDM_DMI_DEVICE", "cpu").strip().lower()
CELL = 2e-9
NX, NY, NZ = 16, 4, 1
SIZE = (NX * CELL, NY * CELL, NZ * CELL)
HALF = (SIZE[0] / 2.0, SIZE[1], SIZE[2])
DT = 1e-14

study = fm.study(f"fdm_dmi_decoupled_{CASE}_{DEVICE}")
study.engine("fdm")
study.device(DEVICE, precision="double")
study.mode("strict")
study.universe(mode="manual", size=SIZE, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(CELL, CELL, CELL)


def configure(body):
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.5
    body.Dind = 2e-3
    # A uniform texture is valid per body; the gate does not depend on m.
    body.m = fm.texture.uniform(0.0, 0.0, 1.0)


if CASE == "bodies":
    for name, sign in (("left", -1.0), ("right", 1.0)):
        configure(study.geometry(fm.Box(size=HALF).translate((sign * SIZE[0] / 4.0, 0.0, 0.0)),
                                 name=name))
else:
    body = study.geometry(fm.Box(size=SIZE), name="film")
    configure(body)
    left = body.add_region("left", fm.Box(size=HALF).translate((-SIZE[0] / 4.0, 0.0, 0.0)))
    right = body.add_region("right", fm.Box(size=HALF).translate((SIZE[0] / 4.0, 0.0, 0.0)))
    if CASE == "disabled":
        study.couplings.exchange(left, right, mode="explicit", inter_exchange=0.0)
    else:
        study.couplings.exchange(left, right, mode="harmonic_mean", scale=0.5)

study.demag(enabled=False)
study.solver(fix_dt=DT, integrator="rk4")
study.run(2 * DT)
