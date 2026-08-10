"""Single-layer identity-transfer FDM runtime variant for oracle coverage."""

from __future__ import annotations

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    FILM_CELL_M,
    FILM_CELLS,
    QUALIFICATION_SCOPE,
)


study = fm.study("mumag_sp4_fdm_multilayer_convolution_l1_cpu_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.fdm(
    default_cell=FILM_CELL_M,
    per_magnet={"layer_bottom": fm.FDMGrid(cell=FILM_CELL_M)},
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=FILM_CELLS[:2],
    ),
)
study.universe(mode="manual", size=(500e-9, 125e-9, 3e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=3e-9, minimum_element_size=3e-9)
bottom = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="layer_bottom_geom"),
    name="layer_bottom",
)
bottom.Ms = 8.0e5
bottom.Aex = 1.3e-11
bottom.alpha = 0.02
bottom.m = fm.init.UniformMagnetization((0.9950371902099893, 0.09950371902099893, 0.0))
study.save("H_demag", every=1e-12)
study.exchange(enabled=True)
study.runtime_metadata(
    "fdm_multilayer_qualification",
    {
        "qualification_scope": QUALIFICATION_SCOPE,
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "variant": "l1_identity",
        "native_layer_cells": FILM_CELLS,
        "native_layer_cell_m": FILM_CELL_M,
    },
)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(1e-13, quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total", "max_torque_T"])
study.stages.add_run(until=1e-14, stage_id="l1_identity")
