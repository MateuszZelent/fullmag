"""Zero-field FEM relaxation qualification for NIST µMAG SP4.

Run interactively on GPU with:
    just fullmag build=True fem gpu tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py

Use cpu instead of gpu to exercise the strict FEM CPU lane.
"""

from pathlib import Path

import fullmag as fm


study = fm.study("mumag_sp4_fem_relax_projected_gradient_bb")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")
study.interactive(True)


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
    # edge_maximum_element_size=1.5e-9,
    # edge_thickness=12e-9,
    # edge_transition_distance=24e-9,
    # corner_maximum_element_size=1e-9,
    # corner_extent=6e-9,
    # corner_transition_distance=12e-9,
    order=1,
)

study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=600,
)
study.mesh.save_or_load(
    Path(__file__).resolve().with_suffix(".fullmag-mesh")
)

study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=100_000,
    tolT=5.8349e-9,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
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
        ),
        fields=[
            fm.FieldAutosave("H_ex", every_steps=100),
            fm.FieldAutosave("H_demag", every_steps=100),
            fm.FieldAutosave("H_eff", every_steps=100),
        ],
    )
)
