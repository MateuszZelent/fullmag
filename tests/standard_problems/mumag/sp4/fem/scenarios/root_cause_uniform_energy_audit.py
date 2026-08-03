"""One-step SP4 demag audit on the immutable P1/P2 comparison mesh."""

from pathlib import Path

import fullmag as fm


study = fm.study("mumag_sp4_fem_root_cause_uniform_energy_audit")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)

study.universe(
    mode="manual",
    size=(1200e-9, 600e-9, 550e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=110e-9,
    maximum_element_growth_rate=1.9,
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
film.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)

study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=600,
)
study.mesh.save_or_load(Path("/tmp/fullmag-sp4-root-cause.fixed.fullmag-mesh"))
study.stages.add_relax(
    stage_id="root-cause-audit",
    algorithm="projected_gradient_bb",
    max_steps=1,
    tolT=1e-6,
).tableautosave(
    every_steps=1,
    quantities=[
        "step",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "e_total",
        "max_torque_T",
    ],
)
