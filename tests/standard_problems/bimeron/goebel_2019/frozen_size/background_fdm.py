"""Independent +x background relaxation for energy differences."""

from __future__ import annotations

import os

import fullmag as fm

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    TRACK_SIZE,
    alpha_from_environment,
    case_from_environment,
    material_from_environment,
)
CASE = case_from_environment()
MATERIAL = material_from_environment()
RELAX_ALPHA = alpha_from_environment()
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
film.Ms = MATERIAL.msat_Apm
film.Aex = MATERIAL.aex_Jpm
film.alpha = RELAX_ALPHA
film.Ku1 = MATERIAL.ku_Jpm3
film.anisU = (1.0, 0.0, 0.0)
film.m = fm.texture.uniform(float(CASE.background_sign), 0.0, 0.0)

study.terms.add(fm.RotatedInterfacialDMI(D=MATERIAL.d_Jpm2))
study.demag(realization="auto")
study.solver(fix_dt=CASE.dt_s, integrator="rk45")
fm.runtime_metadata(
    "bimeron_frozen_size_background",
    {
        "schema_version": "bimeron_frozen_size.background.v1",
        "source_scenario": "tests/standard_problems/bimeron/goebel_2019/frozen_size/background_fdm.py",
        "initial_state": f"uniform({CASE.background_sign:+d}x)",
        "background_sign": CASE.background_sign,
        "material_parameters_source": "explicit_material_metadata_with_environment_overrides",
        "material": MATERIAL.metadata(),
        "alpha": RELAX_ALPHA,
        "track_size_m": list(TRACK_SIZE),
        "track_size_nm": [value * 1e9 for value in TRACK_SIZE],
        "relaxation_tolerance_T": CASE.relax_tol_T,
        "cell_nm": CASE.cell_nm,
        "background_energy_definition": "terminal E_total after independent uniform-background relaxation",
    },
)

relax = study.stages.add_relax(
    stage_id="background_relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt=CASE.dt_s,
    max_steps=CASE.relax_max_steps,
    max_physical_time_s=CASE.relax_time_s,
    tolT=CASE.relax_tol_T,
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
