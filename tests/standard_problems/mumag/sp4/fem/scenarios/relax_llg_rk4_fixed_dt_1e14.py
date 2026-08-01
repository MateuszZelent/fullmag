"""Zero-field FEM relaxation qualification for NIST µMAG SP4.

Run interactively on GPU with:
    just fullmag build=True fem gpu tests/standard_problems/mumag/sp4/fem/scenarios/relax_llg_rk4_fixed_dt_1e14.py

Use cpu instead of gpu to exercise the strict FEM CPU lane.
"""

import fullmag as fm


study = fm.study("mumag_sp4_fem_relax_llg_rk4_fixed_dt_1e14")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")
study.interactive(True)


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
film.mesh(maximum_element_size=3e-9, order=1)

study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=500,
)
study.build_domain_mesh()

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
        "e_total",
        "max_torque_T",
    ],
)

study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk4",
    dt=1e-14,
    relax_alpha=1.0,
    max_steps=50_000,
    tolA=7.957747154594767,
)

