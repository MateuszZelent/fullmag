"""Two-layer unequal-thickness FDM push/pull runtime variant."""

from __future__ import annotations

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    FILM_CELL_M,
    QUALIFICATION_SCOPE,
)


BOTTOM_CELL = FILM_CELL_M
TOP_CELL = FILM_CELL_M
COMMON_CELLS = (160, 40, 2)
INITIAL_M = (0.9950371902099893, 0.09950371902099893, 0.0)

study = fm.study("mumag_sp4_fdm_multilayer_convolution_unequal_cpu_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.fdm(
    default_cell=FILM_CELL_M,
    per_magnet={
        "layer_bottom": fm.FDMGrid(cell=BOTTOM_CELL),
        "layer_top": fm.FDMGrid(cell=TOP_CELL),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="three_d",
        common_cells=COMMON_CELLS,
    ),
)
study.universe(mode="manual", size=(500e-9, 125e-9, 24e-9), center=(0.0, 0.0, 7.5e-9), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=3e-9, minimum_element_size=3e-9)
bottom = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="layer_bottom_geom"),
    name="layer_bottom",
)
top = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 6e-9), name="layer_top_geom").translate((0.0, 0.0, 12e-9)),
    name="layer_top",
)
for layer in (bottom, top):
    layer.Ms = 8.0e5
    layer.Aex = 1.3e-11
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization(INITIAL_M)
study.save("H_demag", every=1e-12)
study.exchange(enabled=True)
study.runtime_metadata(
    "fdm_multilayer_qualification",
    {
        "qualification_scope": QUALIFICATION_SCOPE,
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "variant": "l2_unequal_thickness",
        "native_cells": {
            "layer_bottom": (128, 32, 1),
            "layer_top": (128, 32, 2),
        },
        "native_cell_m": {"layer_bottom": BOTTOM_CELL, "layer_top": TOP_CELL},
        "common_cells": COMMON_CELLS,
    },
)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(1e-13, quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total", "max_torque_T"])
study.stages.add_run(until=1e-14, stage_id="l2_unequal")
