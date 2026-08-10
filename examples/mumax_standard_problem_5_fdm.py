"""MuMax3 Standard Problem 5 reproduced on the Fullmag FDM reference lane.

Source contract: ``external_solvers/3/test/standardproblem5.mx3``.
The geometry, material constants, vortex state, Zhang--Li parameters, and
one-nanosecond observation horizon intentionally remain literal here so the
lowered ProblemIR can be compared with the external script without hidden
defaults. ``FULLMAG_SP5_RUN_UNTIL`` is an explicit diagnostic override for
short stage-to-stage comparisons; the default remains one nanosecond.

Run with the Rust-hosted CLI, for example::

    .fullmag/local/bin/fullmag examples/mumax_standard_problem_5_fdm.py \
        --backend fdm --headless --output-dir run_output/mumax_sp5_fdm
"""

from __future__ import annotations

import os

import fullmag as fm


GRID = (32, 32, 4)
BODY_SIZE = (100e-9, 100e-9, 10e-9)
CELL = tuple(size / count for size, count in zip(BODY_SIZE, GRID))
MSAT = 800e3
AEX = 13e-12
ALPHA = 0.1
CURRENT_DENSITY = (1e12, 0.0, 0.0)
POLARIZATION = 1.0
XI = 0.05
RUN_UNTIL = float(os.environ.get("FULLMAG_SP5_RUN_UNTIL", "1e-9"))
EXECUTION_DEVICE = os.environ.get("FULLMAG_SP5_DEVICE", "cpu").strip().lower()
FIXED_DT_ENV = os.environ.get("FULLMAG_SP5_FIXED_DT", "").strip()
FIXED_DT = float(FIXED_DT_ENV) if FIXED_DT_ENV else None
RELAX_MAX_STEPS = int(os.environ.get("FULLMAG_SP5_RELAX_MAX_STEPS", "100000"))
RELAX_TOL_T = float(os.environ.get("FULLMAG_SP5_RELAX_TOL_T", "1e-6"))

if FIXED_DT is not None and FIXED_DT <= 0.0:
    raise ValueError("FULLMAG_SP5_FIXED_DT must be positive")
if RUN_UNTIL <= 0.0:
    raise ValueError("FULLMAG_SP5_RUN_UNTIL must be positive")


study = fm.study("mumax_standard_problem_5_fdm")
study.engine("fdm")
study.device(EXECUTION_DEVICE, precision="double")
study.universe(
    mode="manual",
    size=BODY_SIZE,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(*CELL)

plate = study.geometry(fm.Box(size=BODY_SIZE, name="plate"), name="plate")
plate.Ms = MSAT
plate.Aex = AEX
plate.alpha = ALPHA
plate.m = fm.texture.vortex(circulation=1, core_polarity=1)

study.exchange()
study.demag()
# The standard-problem reference uses gamma=2.211e5 m/(A s).  Fullmag's
# explicit gamma field avoids silently substituting a different g-factor.
if FIXED_DT is None:
    study.solver(
        integrator="rk45",
        max_err=1e-5,
        dt_initial=1e-15,
        dt_max=1e-11,
        gamma=2.211e5,
    )
    relax_kwargs = {
        "solver": "rk45",
        "dt": "auto",
        "max_error": 1e-5,
        "dt_min": 1e-16,
        "dt_max": 1e-11,
    }
else:
    study.solver(integrator="heun", fix_dt=FIXED_DT, gamma=2.211e5)
    relax_kwargs = {"solver": "heun", "dt": FIXED_DT}

study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    tolT=RELAX_TOL_T,
    max_steps=RELAX_MAX_STEPS,
    # MuMax's relax() uses an internal overdamped controller.  Fullmag keeps
    # the physical alpha for the run stage and makes this numerical choice
    # explicit only for the equilibrium pre-stage.
    relax_alpha=1.0,
    **relax_kwargs,
)

# MuMax's J/Pol/xi fields describe the CIP Zhang--Li torque.  Fullmag names
# the equivalent public fields current_density/degree/beta and accepts xi as
# the compatibility alias for beta.
study.spin_torque(
    fm.ZhangLiSTT(
        current_density=CURRENT_DENSITY,
        degree=POLARIZATION,
        xi=XI,
        id="sp5_zhang_li",
        target=fm.RegionRef("plate"),
        lande_g=2.0,
        operator_version="zl_mumax3_central_v1",
    )
)
study.stages.add_run(RUN_UNTIL, stage_id="current_run")
