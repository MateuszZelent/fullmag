"""Adaptive-RK macrospin case for the FDM per-step adaptive gate (note 0480 §10).

Run with the headless runner, once per lane, for example:
    FDM_MACROSPIN_DEVICE=gpu fullmag-bin scripts/fdm_adaptive_macrospin_case.py \
        --backend fdm --headless --json --output-dir <dir>
then compare the outputs with scripts/fdm_adaptive_macrospin_check.py.
"""

# %% Study and execution intent
import os

import fullmag as fm

DEVICE = os.environ.get("FDM_MACROSPIN_DEVICE", "cpu")
PRECISION = os.environ.get("FDM_MACROSPIN_PRECISION", "double")
INTEGRATOR = os.environ.get("FDM_MACROSPIN_INTEGRATOR", "rk45")
MAX_ERR = float(os.environ.get("FDM_MACROSPIN_MAX_ERR", "1e-6"))
UNTIL_S = float(os.environ.get("FDM_MACROSPIN_UNTIL", "1e-9"))

study = fm.study("fdm_adaptive_macrospin")
study.engine("fdm")
study.device(DEVICE, precision=PRECISION)
study.mode("strict")

# %% Grid, geometry, material and initial state in SI
study.universe(
    mode="manual",
    size=(20e-9, 20e-9, 5e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 5e-9)
body = study.geometry(fm.Box(size=(20e-9, 20e-9, 5e-9), name="macrospin"), name="macrospin")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.01
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

# %% Interactions, adaptive solver, stage and table output
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 50e-3)
study.solver(
    integrator=INTEGRATOR,
    dt_initial=1e-13,
    dt_min=1e-16,
    dt_max=2e-12,
    max_err=MAX_ERR,
    g=2.0,
)
study.tableautosave(UNTIL_S / 50, quantities=["time", "mx", "my", "mz", "E_total"])
study.stages.add_run(stage_id="run", until=UNTIL_S)
