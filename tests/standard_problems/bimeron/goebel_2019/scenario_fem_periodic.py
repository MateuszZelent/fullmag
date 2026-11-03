"""Göbel 2019 bimeron relaxation and hold with x-periodic FEM CPU."""

from __future__ import annotations

from pathlib import Path

import fullmag as fm

from tests.standard_problems.bimeron.goebel_2019.common import (
    AEX,
    ALPHA,
    BIMERON_RADIUS,
    BIMERON_WALL_WIDTH,
    D_ROTATED,
    GAMMA_H,
    HOLD_SAMPLE_PERIOD,
    HOLD_TIME,
    KU_X,
    LLG_DT,
    MS,
    RELAX_FIELD_EVERY_STEPS,
    RELAX_MAX_STEPS,
    RELAX_TIME,
    TRACK_SIZE,
)
from tests.standard_problems.bimeron.goebel_2019.periodic_tet4_mesh import (
    AIRBOX_SIZE,
    MESH_FILENAME,
)


study = fm.study("goebel_2019_bimeron_fem_periodic")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# Match the film length at the x seam and allow 40 nm of air on each
# open y and z face. The finite Robin boundary is part of the FEM model.
study.universe(
    mode="manual",
    size=AIRBOX_SIZE,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.pbc(x=True, demag="periodic_airbox_k0")

film = study.geometry(fm.Box(size=TRACK_SIZE, name="film"), name="film")
film.Ms = MS
film.Aex = AEX
film.alpha = ALPHA
film.Ku1 = KU_X
film.anisU = (1.0, 0.0, 0.0)
film.m = fm.texture.bimeron(
    radius=BIMERON_RADIUS,
    wall_width=BIMERON_WALL_WIDTH,
    vorticity=-1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
)

film.mesh(order=1)
study.domain_mesh(Path(__file__).with_name(MESH_FILENAME), region_markers={"film": 1})

study.terms.add(fm.RotatedInterfacialDMI(D=D_ROTATED))
study.demag(realization="poisson_robin")
study.solver(fix_dt=LLG_DT, integrator="rk45", gamma=GAMMA_H)

relax = study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt=LLG_DT,
    max_steps=RELAX_MAX_STEPS,
    max_physical_time_s=RELAX_TIME,
    relax_alpha=ALPHA,
    tolT=1e-6,
)
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "t", "mx", "my", "mz", "E_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("m", every_steps=RELAX_FIELD_EVERY_STEPS)],
    )
)
study.stages.add_save_state(
    artifact_name="relaxed_m.zarr",
    format="zarr",
    dataset="m",
)

hold = study.stages.add_run(stage_id="hold", until=HOLD_TIME)
hold.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            t_sampl=HOLD_SAMPLE_PERIOD,
            quantities=["step", "t", "mx", "my", "mz", "E_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("m", every=HOLD_SAMPLE_PERIOD)],
    )
)
study.stages.add_save_state(
    artifact_name="held_m.zarr",
    format="zarr",
    dataset="m",
)
