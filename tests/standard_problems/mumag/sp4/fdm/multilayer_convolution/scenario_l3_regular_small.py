"""Small Appendix-A L=3 regular FDM identity-transfer runtime case."""

from __future__ import annotations

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    QUALIFICATION_SCOPE,
)


CELL = (3.90625e-9, 3.90625e-9, 3e-9)
SIZE = (31.25e-9, 15.625e-9, 3e-9)
COMMON_CELLS_XY = (8, 4)
INITIAL_M = (0.9950371902099893, 0.09950371902099893, 0.0)

study = fm.study("mumag_sp4_fdm_multilayer_convolution_l3_regular_small")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.fdm(
    default_cell=CELL,
    per_magnet={
        "layer_bottom": fm.FDMGrid(cell=CELL),
        "layer_middle": fm.FDMGrid(cell=CELL),
        "layer_top": fm.FDMGrid(cell=CELL),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=COMMON_CELLS_XY,
    ),
)
study.universe(
    mode="manual",
    size=(40e-9, 20e-9, 30e-9),
    center=(0.0, 0.0, 9e-9),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=3e-9, minimum_element_size=3e-9)
bottom = study.geometry(fm.Box(size=SIZE, name="layer_bottom_geom"), name="layer_bottom")
middle = study.geometry(
    fm.Box(size=SIZE, name="layer_middle_geom").translate((0.0, 0.0, 9e-9)),
    name="layer_middle",
)
top = study.geometry(
    fm.Box(size=SIZE, name="layer_top_geom").translate((0.0, 0.0, 18e-9)),
    name="layer_top",
)
for layer in (bottom, middle, top):
    layer.Ms = 8.0e5
    layer.Aex = 1.3e-11
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization(INITIAL_M)

study.save("H_demag", every=1e-12)
study.runtime_metadata(
    "fdm_multilayer_qualification",
    {
        "qualification_scope": QUALIFICATION_SCOPE,
        "appendix_case": "Appendix-A L=3 regular small; not canonical SP4",
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "variant": "l3_regular_identity_small",
        "native_cells": {
            "layer_bottom": (8, 4, 1),
            "layer_middle": (8, 4, 1),
            "layer_top": (8, 4, 1),
        },
        "native_cell_m": CELL,
        "common_cells_xy": COMMON_CELLS_XY,
    },
)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(
    1e-13,
    quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total", "max_torque_T"],
)
study.stages.add_run(until=1e-14, stage_id="l3_regular_small")
