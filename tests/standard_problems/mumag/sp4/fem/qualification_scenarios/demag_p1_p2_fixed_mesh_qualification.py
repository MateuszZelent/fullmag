"""Fixed-mesh P2 candidate for FEM SP4 demag qualification.

The current runtime resolves the nonperiodic Poisson-Robin potential to P2;
this script does not reproduce a P1 run. Generate the mesh once and retain a
P1 root-cause report produced by the captured P1 runtime, then keep
``FULLMAG_SP4_FIXED_MESH`` unchanged for this P2 candidate. The validator
requires the P1 report and P2 artifacts to carry the same mesh identity.

Managed execution example:
    FULLMAG_SP4_FIXED_MESH=/absolute/path/sp4-edge.fullmag-mesh \
      FULLMAG_RELAX_MAX_STEPS=1 just fem-managed-headless cpu \
      tests/standard_problems/mumag/sp4/fem/qualification_scenarios/demag_p1_p2_fixed_mesh_qualification.py \
      /absolute/path/output
"""

from __future__ import annotations

import os
from pathlib import Path

import fullmag as fm


study = fm.study("mumag_sp4_fem_demag_p2_fixed_mesh_qualification")
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
    minimum_element_size=8e-9,
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
film.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=8e-9,
    edge_maximum_element_size=1e-9,
    edge_thickness=6e-9,
    edge_transition_distance=12e-9,
    corner_maximum_element_size=1e-9,
    corner_extent=8e-9,
    corner_transition_distance=16e-9,
    transition_growth=1.35,
    order=1,
    algorithm_2d=1,
    algorithm_3d=1,
)

study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=600,
)
fixed_mesh = Path(
    os.environ.get(
        "FULLMAG_SP4_FIXED_MESH",
        str(Path(__file__).resolve().with_suffix(".fullmag-mesh")),
    )
)
study.mesh.save_or_load(fixed_mesh)

maximum_steps = int(os.environ.get("FULLMAG_RELAX_MAX_STEPS", "100000"))
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=maximum_steps,
    tolT=1e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
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
        ),
        fields=[
            fm.FieldAutosave("m", every_steps=1),
            fm.FieldAutosave("H_demag", every_steps=1),
            fm.FieldAutosave("demag_phi", every_steps=1),
        ],
    )
)
