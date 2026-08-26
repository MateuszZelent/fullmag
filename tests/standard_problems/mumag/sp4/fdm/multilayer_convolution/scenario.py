"""SP4-derived flat FDM study for the multilayer-convolution CPU gate."""

from __future__ import annotations

from pathlib import Path
import sys

import fullmag as fm


SCENARIO_PATH = Path(__file__).resolve()
REPOSITORY_ROOT = SCENARIO_PATH.parents[6]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    FILM_CELL_M,
    FILM_CELLS,
    QUALIFICATION_SCOPE,
)


SCENARIO_ID = "mumag_sp4_fdm_multilayer_convolution_cpu_reference"

# Deliberately changed target-only Airbox mesh: 160 x 40 in XY, 9 cells below
# and 5 above the bilayer.  It is not a magnetic source grid.
AIRBOX_RUNTIME: dict[str, object] = {
    "cells": (160, 40, 18),
    "cells_xy": (160, 40),
    "spacing_m": (3.125e-9, 3.125e-9, 3e-9),
    "origin_m": (-250e-9, -62.5e-9, -28.5e-9),
    "size_m": (500e-9, 125e-9, 54e-9),
    "center_m": (0.0, 0.0, -1.5e-9),
    "padding_cells_above_below": (5, 9),
    "target_only": True,
    "scope_kind": "airbox",
    "published_quantities": ("H_demag",),
    "unavailable_quantities": {"H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"},
    "coordinate_system": "cartesian_si",
    "cell_center_rule": "origin + (i+0.5,j+0.5,k+0.5)*spacing",
}

STUDY_METADATA: dict[str, object] = {
    "scenario_id": SCENARIO_ID,
    "qualification_scope": QUALIFICATION_SCOPE,
    "runtime_qualification": "blocked_c1_runtime_artifacts",
    "backend": "fdm",
    "device": "cpu",
    "precision": "double",
    "requested_strategy": "multilayer_convolution",
    "requested_mode": "two_d_stack",
    "native_layer_cells": FILM_CELLS,
    "native_layer_cell_m": FILM_CELL_M,
    "inter_object_exchange": "disabled",
    "airbox": AIRBOX_RUNTIME,
    "outputs_required": (
        "H_demag field samples in A/m",
        "E_demag in J",
        "cross-layer coupling H_A<-B and coupling energy in J",
    ),
    "runtime_artifact_schema": "sp4_fdm_multilayer_runtime.v1",
}


# Canonical flat authoring surface consumed by the Python loader.
study = fm.study(SCENARIO_ID)
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
        common_cells_xy=(160, 40),
    ),
)
study.universe(
    mode="manual",
    size=AIRBOX_RUNTIME["size_m"],  # type: ignore[arg-type]
    center=AIRBOX_RUNTIME["center_m"],  # type: ignore[arg-type]
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
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="layer_bottom_geom").translate(
        (0.0, 0.0, 0.0)
    ),
    name="layer_bottom",
)
top = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="layer_top_geom").translate(
        # The translated FDM asset is materialized in the Cartesian/domain
        # frame, so +9 nm places the upper film above the lower film.
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

# Emit real per-layer H_demag snapshots for the CPU reference artifact.  The
# target-only Airbox remains a visualization/provenance surface; it is not
# silently substituted for a magnetic source grid.
study.save("H_demag", every=1e-12)

# Disconnected bodies keep exchange local; no inter-object exchange edge is
# authored.  This condition is recorded in runtime provenance below.
study.runtime_metadata("fdm_multilayer_qualification", STUDY_METADATA)
study.runtime_metadata("airbox_observation", AIRBOX_RUNTIME)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(
    1e-13,
    quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total", "max_torque_T"],
)
study.stages.add_run(until=1e-12, stage_id="cpu_reference")
