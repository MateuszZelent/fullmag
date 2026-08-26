"""Identity-transfer CPU run with a wider target-only Airbox observation mesh."""

from __future__ import annotations

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    FILM_CELL_M,
    FILM_CELLS,
    QUALIFICATION_SCOPE,
)


AIRBOX_RUNTIME = {
    "cells": (160, 40, 24),
    "cells_xy": (160, 40),
    "spacing_m": (3.125e-9, 3.125e-9, 3e-9),
    "origin_m": (-250e-9, -62.5e-9, -37.5e-9),
    "size_m": (500e-9, 125e-9, 72e-9),
    "center_m": (0.0, 0.0, -1.5e-9),
    "padding_cells_above_below": (9, 13),
    "target_only": True,
    "scope_kind": "airbox",
    "published_quantities": ("H_demag",),
    "unavailable_quantities": {"H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"},
    "coordinate_system": "cartesian_si",
    "cell_center_rule": "origin + (i+0.5,j+0.5,k+0.5)*spacing",
}


study = fm.study("mumag_sp4_fdm_multilayer_convolution_identity_airbox_wider")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.fdm(
    default_cell=FILM_CELL_M,
    per_magnet={
        "layer_bottom": fm.FDMGrid(cell=FILM_CELL_M),
        "layer_top": fm.FDMGrid(cell=FILM_CELL_M),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=FILM_CELLS[:2],
    ),
)
study.universe(
    mode="manual",
    size=AIRBOX_RUNTIME["size_m"],
    center=AIRBOX_RUNTIME["center_m"],
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=3e-9, minimum_element_size=3e-9)
study.airbox.visualization(
    show=True,
    mode="surface+edges",
    active_quantity_id="H_demag",
    wireframe=True,
    shaded=False,
    bounds=True,
    points=False,
    opacity=18.0,
    geometry_scope="full",
)

bottom = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="layer_bottom_geom"),
    name="layer_bottom",
)
top = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="layer_top_geom").translate(
        (0.0, 0.0, 9e-9)
    ),
    name="layer_top",
)
initial_m = (0.9950371902099893, 0.09950371902099893, 0.0)
for layer in (bottom, top):
    layer.Ms = 8.0e5
    layer.Aex = 1.3e-11
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization(initial_m)

study.save("H_demag", every=1e-12)
study.runtime_metadata(
    "fdm_multilayer_qualification",
    {
        "variant": "identity_common_grid_airbox_wider",
        "qualification_scope": QUALIFICATION_SCOPE,
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "native_layer_cells": FILM_CELLS,
        "native_layer_cell_m": FILM_CELL_M,
        "common_cells_xy": FILM_CELLS[:2],
        "airbox": AIRBOX_RUNTIME,
    },
)
study.runtime_metadata("airbox_observation", AIRBOX_RUNTIME)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(
    1e-13,
    quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total", "max_torque_T"],
)
study.stages.add_run(until=1e-14, stage_id="identity_airbox_wider")
