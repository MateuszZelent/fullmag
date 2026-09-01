"""Göbel 2019 bimeron relaxation and zero-current hold on a one-layer FEM film."""

from __future__ import annotations

import fullmag as fm

from tests.standard_problems.bimeron.goebel_2019.common import (
    AEX,
    ALPHA,
    BIMERON_RADIUS,
    BIMERON_WALL_WIDTH,
    D_ROTATED,
    HOLD_SAMPLE_PERIOD,
    HOLD_TIME,
    KU_X,
    LLG_DT,
    MS,
    RELAX_FIELD_EVERY_STEPS,
    RELAX_MAX_STEPS,
    RELAX_TIME,
    TRACK_SIZE,
    requested_device,
)


REQUESTED_DEVICE = requested_device()

study = fm.study("goebel_2019_bimeron_fem")
study.engine("fem")
study.device(REQUESTED_DEVICE, precision="double")
study.mode("strict")
study.pbc(x=True, demag="truncated_images")

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
film.mesh.thin_film(
    minimum_element_size=0.5e-9,
    maximum_element_size=1.0e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)

study.terms.add(fm.RotatedInterfacialDMI(D=D_ROTATED))
study.demag(realization="poisson_robin")
study.solver(fix_dt=LLG_DT, integrator="rk45")
study.build_domain_mesh()

relax = study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt=LLG_DT,
    max_steps=RELAX_MAX_STEPS,
    max_physical_time_s=RELAX_TIME,
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

hold = study.stages.add_run(stage_id="hold", until=RELAX_TIME + HOLD_TIME)
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
