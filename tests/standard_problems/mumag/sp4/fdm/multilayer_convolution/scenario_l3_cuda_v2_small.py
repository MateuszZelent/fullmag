"""SP4-derived L=3 identity-grid fixture that forces native CUDA ABI v2 demag."""

from __future__ import annotations

import os

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    QUALIFICATION_SCOPE,
)


CELL = (3.90625e-9, 3.90625e-9, 3e-9)
SIZE = (31.25e-9, 15.625e-9, 6e-9)
COMMON_CELLS = (8, 4, 2)
INITIAL_M = (0.9950371902099893, 0.09950371902099893, 0.0)
PRECISION = os.environ.get("FULLMAG_FDM_MULTILAYER_SCENARIO_PRECISION", "double")

study = fm.study("mumag_sp4_fdm_multilayer_convolution_l3_cuda_v2_small")
study.engine("fdm")
study.device("cpu", precision=PRECISION)
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
        mode="three_d",
        common_cells=COMMON_CELLS,
    ),
)
study.universe(
    mode="manual",
    size=(40e-9, 20e-9, 36e-9),
    center=(0.0, 0.0, 12e-9),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=3e-9, minimum_element_size=3e-9)
bottom = study.geometry(fm.Box(size=SIZE, name="layer_bottom_geom"), name="layer_bottom")
middle = study.geometry(
    fm.Box(size=SIZE, name="layer_middle_geom").translate((0.0, 0.0, 12e-9)),
    name="layer_middle",
)
top = study.geometry(
    fm.Box(size=SIZE, name="layer_top_geom").translate((0.0, 0.0, 24e-9)),
    name="layer_top",
)
for layer, saturation_magnetisation in zip(
    (bottom, middle, top),
    (8.0e5, 7.8e5, 8.2e5),
):
    layer.Ms = saturation_magnetisation
    layer.Aex = 1.3e-11
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization(INITIAL_M)

study.save("H_demag", every=1e-14)
study.runtime_metadata(
    "fdm_multilayer_qualification",
    {
        "qualification_scope": QUALIFICATION_SCOPE,
        "appendix_case": "Appendix-A L=3 CUDA ABI v2 small; not canonical SP4",
        "backend": "fdm",
        "requested_device": "runtime environment override",
        "precision": PRECISION,
        "variant": "l3_cuda_v2_identity_distinct_materials_small",
        "common_cells": COMMON_CELLS,
        "transfer": "identity",
        "distinct_saturation_magnetisation_apm": (8.0e5, 7.8e5, 8.2e5),
    },
)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(
    1e-14,
    quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total"],
)
study.stages.add_run(until=1e-14, stage_id="l3_cuda_v2_small")
