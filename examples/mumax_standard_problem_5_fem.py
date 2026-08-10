"""FEM counterpart of MuMax3 Standard Problem 5.

This fixture keeps the physical workload from
``external_solvers/3/test/standardproblem5.mx3`` explicit: a 100 nm x 100 nm
x 10 nm Permalloy plate, a (circulation=1, polarity=1) vortex, exchange and
free-boundary Poisson--Robin demagnetization, followed by a 1 ns CIP
Zhang--Li drive.  FEM uses its canonical ``zhang_li.fullmag.v1`` realization;
the MuMax3-compatible FDM realization is deliberately rejected on FEM by the
planner and must not be silently substituted.

The environment variables make a short managed probe possible without
changing the source contract:

``FULLMAG_SP5_FEM_DEVICE``
    ``cpu`` (default) or ``gpu``.
``FULLMAG_SP5_FEM_MAX_ELEMENT_SIZE`` / ``...MIN_ELEMENT_SIZE``
    body mesh targets in metres (defaults 8 nm / 3 nm).
``FULLMAG_SP5_FEM_UNIVERSE_MAX_ELEMENT_SIZE``
    air/universe mesh target (default 30 nm).
``FULLMAG_SP5_FEM_RELAX_MAX_STEPS``
    relaxation budget (default 10000).
``FULLMAG_SP5_FEM_RELAX_TOL_T``
    relaxation torque tolerance in tesla (default 1e-6 T).
``FULLMAG_SP5_FEM_RELAX_ALGORITHM``
    ``llg_overdamped`` (source-compatible default) or a FEM minimizer such as
    ``projected_gradient_bb``.  The latter is useful for a converged FEM
    equilibrium probe because it does not spend physical pseudo-time on the
    damping trajectory.
``FULLMAG_SP5_FEM_FIXED_DT``
    optional fixed dynamics timestep; omitted means the native default.
``FULLMAG_SP5_FEM_RUN_UNTIL``
    dynamic horizon in seconds (default 1 ns).

The default is intentionally a complete workload.  A bounded probe should set
an explicit smaller relaxation budget and/or horizon and must be labelled
diagnostic in any report.
"""

from __future__ import annotations

import os

import fullmag as fm


BODY_SIZE = (100e-9, 100e-9, 10e-9)
MSAT = 800e3
AEX = 13e-12
ALPHA = 0.1
CURRENT_DENSITY = (1e12, 0.0, 0.0)
POLARIZATION = 1.0
XI = 0.05
RUN_UNTIL = float(os.environ.get("FULLMAG_SP5_FEM_RUN_UNTIL", "1e-9"))
DEVICE = os.environ.get("FULLMAG_SP5_FEM_DEVICE", "cpu").strip().lower()
BODY_HMAX = float(
    os.environ.get("FULLMAG_SP5_FEM_MAX_ELEMENT_SIZE", "8e-9")
)
BODY_HMIN = float(
    os.environ.get("FULLMAG_SP5_FEM_MIN_ELEMENT_SIZE", "3e-9")
)
UNIVERSE_HMAX = float(
    os.environ.get("FULLMAG_SP5_FEM_UNIVERSE_MAX_ELEMENT_SIZE", "30e-9")
)
RELAX_MAX_STEPS = int(
    os.environ.get("FULLMAG_SP5_FEM_RELAX_MAX_STEPS", "10000")
)
RELAX_TOL_T = float(
    os.environ.get("FULLMAG_SP5_FEM_RELAX_TOL_T", "1e-6")
)
RELAX_ALGORITHM = os.environ.get(
    "FULLMAG_SP5_FEM_RELAX_ALGORITHM", "llg_overdamped"
).strip().lower()
DEMAG_RTOL = float(
    os.environ.get(
        "FULLMAG_SP5_FEM_DEMAG_RTOL",
        "1e-12" if RELAX_ALGORITHM != "llg_overdamped" else "1e-10",
    )
)
FIXED_DT_ENV = os.environ.get("FULLMAG_SP5_FEM_FIXED_DT", "").strip()
FIXED_DT = float(FIXED_DT_ENV) if FIXED_DT_ENV else None

if DEVICE not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_SP5_FEM_DEVICE must be cpu or gpu")
if RUN_UNTIL <= 0.0:
    raise ValueError("FULLMAG_SP5_FEM_RUN_UNTIL must be positive")
if BODY_HMIN <= 0.0 or BODY_HMAX <= 0.0 or BODY_HMIN > BODY_HMAX:
    raise ValueError("FEM body mesh sizes must be positive and min <= max")
if UNIVERSE_HMAX <= 0.0:
    raise ValueError("FULLMAG_SP5_FEM_UNIVERSE_MAX_ELEMENT_SIZE must be positive")
if RELAX_MAX_STEPS <= 0:
    raise ValueError("FULLMAG_SP5_FEM_RELAX_MAX_STEPS must be positive")
if RELAX_TOL_T <= 0.0:
    raise ValueError("FULLMAG_SP5_FEM_RELAX_TOL_T must be positive")
if not (0.0 < DEMAG_RTOL < 1.0):
    raise ValueError("FULLMAG_SP5_FEM_DEMAG_RTOL must be between 0 and 1")
if RELAX_ALGORITHM not in {"llg_overdamped", "projected_gradient_bb", "nonlinear_cg", "tangent_plane_implicit"}:
    raise ValueError(
        "FULLMAG_SP5_FEM_RELAX_ALGORITHM must be llg_overdamped, "
        "projected_gradient_bb, nonlinear_cg, or tangent_plane_implicit"
    )
if FIXED_DT is not None and FIXED_DT <= 0.0:
    raise ValueError("FULLMAG_SP5_FEM_FIXED_DT must be positive")


study = fm.study("mumax_standard_problem_5_fem")
study.engine("fem")
study.device(DEVICE, precision="double")
study.interactive(False)
study.universe(
    mode="auto",
    size=(160e-9, 160e-9, 70e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=UNIVERSE_HMAX,
    growth_rate=1.5,
    grading="geometric",
)

plate = study.geometry(fm.Box(size=BODY_SIZE, name="plate"), name="plate")
plate.Ms = MSAT
plate.Aex = AEX
plate.alpha = ALPHA
plate.m = fm.texture.vortex(circulation=1, core_polarity=1)
plate.mesh(
    minimum_element_size=BODY_HMIN,
    maximum_element_size=BODY_HMAX,
    order=1,
    algorithm_2d=6,
    algorithm_3d=1,
    size_from_curvature=8,
    smoothing_steps=1,
    optimize_iterations=1,
)

study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=DEMAG_RTOL,
    max_iterations=500,
)
study.build_domain_mesh()

if FIXED_DT is None:
    study.solver(
        integrator="rk45",
        max_err=1e-5,
        dt_initial=1e-15,
        dt_max=1e-11,
        gamma=2.211e5,
    )
else:
    study.solver(integrator="heun", fix_dt=FIXED_DT, gamma=2.211e5)

study.save("m", every=1e-10)
study.save("H_demag", every=1e-10)

if RELAX_ALGORITHM == "llg_overdamped":
    relax_stage = study.stages.add_relax(
        stage_id="relax",
        algorithm=RELAX_ALGORITHM,
        tolT=RELAX_TOL_T,
        max_steps=RELAX_MAX_STEPS,
        relax_alpha=1.0,
        solver="rk45",
        dt="auto",
        max_error=1e-5,
        dt_min=1e-16,
        dt_max=1e-11,
    )
else:
    relax_stage = study.stages.add_relax(
        stage_id="relax",
        algorithm=RELAX_ALGORITHM,
        tolT=RELAX_TOL_T,
        max_steps=RELAX_MAX_STEPS,
    )
relax_stage.tableautosave(
    every_steps=1,
    quantities=["time", "step", "mx", "my", "mz", "E_total", "max_dm_dt"],
)

# MuMax3 assigns J/Pol/xi after relax(), so the equilibrium stage is
# conservative.  FEM deliberately uses the canonical fullmag realization for
# the following dynamic stage; the FDM MuMax3-compatibility realization has a
# different public lane and is rejected by the planner on FEM.
study.spin_torque(
    fm.ZhangLiSTT(
        current_density=CURRENT_DENSITY,
        degree=POLARIZATION,
        xi=XI,
        id="sp5_zhang_li_fem",
        target=fm.RegionRef("plate"),
        lande_g=2.0,
        operator_version="zl_central_reference_v1",
    )
)
study.stages.add_run(RUN_UNTIL, stage_id="current_run")
