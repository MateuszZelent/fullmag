"""Relax the shared Py layer with the static x-directed bias only."""

from __future__ import annotations

import fullmag as fm


FILM_SIZE_M = (500e-9, 500e-9, 10e-9)
CELL_SIZE_M = (2.5e-9, 2.5e-9, 10e-9)
MS_A_PER_M = 800e3
AEX_J_PER_M = 13e-12
ALPHA = 0.01
B_EXT_T = (100e-3, 0.0, 0.0)
RELAX_TABLE_QUANTITIES = (
    "step",
    "t",
    "mx",
    "my",
    "mz",
    "e_ex",
    "e_demag",
    "e_ext",
    "e_drive",
    "e_ani",
    "e_dmi",
    "e_total",
)


study = fm.study("fdm_mumax3_sinc_layer_relaxation")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=FILM_SIZE_M,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(*CELL_SIZE_M)

body = study.geometry(fm.Box(size=FILM_SIZE_M, name="py_layer_geometry"), name="py_layer", object_id="py_layer")
body.Ms = MS_A_PER_M
body.Aex = AEX_J_PER_M
body.alpha = ALPHA
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.demag(realization="auto")
study.b_ext(*B_EXT_T)
study.runtime_metadata(
    "fdm_mumax3_sinc_layer_relaxation",
    {
        "schema_version": "fdm_mumax3_sinc_layer_relaxation.v1",
        "backend": "fdm",
        "geometry_size_m": list(FILM_SIZE_M),
        "cell_size_m": list(CELL_SIZE_M),
        "pbc": [False, False, False],
        "material": {
            "name": "Py",
            "Ms_A_per_m": MS_A_PER_M,
            "A_J_per_m": AEX_J_PER_M,
            "alpha": ALPHA,
        },
        "static_bias_B_T": list(B_EXT_T),
        "algorithm": "nonlinear_cg",
        "torque_tolerance_T": 1e-6,
        "max_steps": 50000,
        "magnetization_field_outputs": False,
    },
)
relax = study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    tolT=1e-6,
    max_steps=50000,
)
relax.tableautosave(every_steps=100, quantities=RELAX_TABLE_QUANTITIES)
