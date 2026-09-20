"""Independent +x background relaxation for energy differences."""

from __future__ import annotations

import os

import fullmag as fm

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    AEX,
    ALPHA,
    D_ROTATED,
    KU_X,
    MS,
    TRACK_SIZE,
    case_from_environment,
)
CASE = case_from_environment()
REQUESTED_DEVICE = os.environ.get("FULLMAG_BIMERON_DEVICE", "gpu").strip().lower()
if REQUESTED_DEVICE not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_BIMERON_DEVICE must be cpu or gpu")

study = fm.study("goebel_2019_bimeron_frozen_size_background_fdm")
study.engine("fdm")
study.device(REQUESTED_DEVICE, precision="double")
study.mode("strict")
study.cell(*CASE.cell_m)
study.pbc(x=True, demag="truncated_images")

film = study.geometry(fm.Box(size=TRACK_SIZE, name="film"), name="film")
film.Ms = MS
film.Aex = AEX
film.alpha = ALPHA
film.Ku1 = KU_X
film.anisU = (1.0, 0.0, 0.0)
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.terms.add(fm.RotatedInterfacialDMI(D=D_ROTATED))
study.demag(realization="auto")
study.solver(fix_dt=CASE.dt_s, integrator="rk45")
fm.runtime_metadata(
    "bimeron_frozen_size_background",
    {
        "schema_version": "bimeron_frozen_size.background.v1",
        "source_scenario": "tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py",
        "initial_state": "uniform(+x)",
        "same_rDMI_parameters": True,
        "cell_nm": CASE.cell_nm,
        "background_energy_definition": "terminal E_total after independent +x relaxation",
    },
)

relax = study.stages.add_relax(
    stage_id="background_relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt=CASE.dt_s,
    max_steps=CASE.relax_max_steps,
    max_physical_time_s=CASE.relax_time_s,
    tolT=1e-6,
)
relax.autosave(
    fm.StageAutosave(
        target="background",
        layout="separate",
        table=fm.TableAutosave(
            every_steps=10,
            quantities=[
                "step",
                "t",
                "mx",
                "my",
                "mz",
                "e_ex",
                "e_demag",
                "e_ext",
                "e_ani",
                "e_dmi",
                "e_total",
                "max_torque_T",
            ],
            table_id="background_relax",
        ),
        fields=[fm.FieldAutosave("m", every_steps=CASE.field_every_steps)],
    )
)
study.stages.add_save_state(
    artifact_name="background_relaxed_m.zarr",
    format="zarr",
    dataset="m",
)
