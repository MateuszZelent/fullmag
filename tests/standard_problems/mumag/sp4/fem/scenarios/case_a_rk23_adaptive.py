"""NIST µMAG SP4 case A with Fullmag rk23 (adaptive step).

Run interactively on GPU with:
    just fullmag build=True fem gpu tests/standard_problems/mumag/sp4/fem/scenarios/case_a_rk23_adaptive.py

Use cpu instead of gpu to exercise the strict FEM CPU lane.
"""

import fullmag as fm


study = fm.study("mumag_sp4_fem_case_a_rk23_adaptive")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")
study.interactive(True)


# NIST film and the baseline open-boundary FEM air domain.
study.universe(
    mode="manual",
    size=(700e-9, 250e-9, 250e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=20e-9,
    maximum_element_growth_rate=1.7,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
# Use the nominal 3 nm NIST/OOMMF resolution without forcing explicit
# sub-nanometre layers that degenerate the conformal airbox tetrahedra.
film.mesh(maximum_element_size=3e-9, order=1)

study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=500,
)
study.build_domain_mesh()
study.solver(
    integrator="rk23",
    dt_initial=1e-15,
    dt_min=1e-17,
    dt_max=2e-13,
    max_err=1e-7,
    gamma=2.211e5,
)

# Accepted-state observables are written by the application, not reconstructed
# from console logs by the test harness.
study.tableautosave(
    1e-12,
    quantities=[
        "step",
        "t",
        "dt",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "e_ext",
        "e_total",
        "max_torque_T",
    ],
)

# Prepare the zero-field S-state.
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk23",
    dt_initial=1e-15,
    dt_min=1e-17,
    dt_max=1e-14,
    max_err=1e-7,
    relax_alpha=1.0,
    max_steps=50_000,
    tol=7.957747154594767,
)

# Apply the official reversal field only after relaxation.
study.b_ext(*(-24.6e-3, 4.3e-3, 0.0))
study.stages.autosave("m", every=1e-12, stage_id="autosave-m")
study.stages.add_run(until=5e-9, stage_id="reversal")
