"""Identity-transfer FDM multilayer runtime variant for oracle coverage."""

from __future__ import annotations

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    FILM_CELL_M,
    FILM_CELLS,
)
from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.scenario import (
    AIRBOX_RUNTIME,
    bottom,
    study,
    top,
)


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
study.runtime_metadata(
    "fdm_multilayer_identity_oracle",
    {
        "variant": "identity_common_grid",
        "native_layer_cells": FILM_CELLS,
        "native_layer_cell_m": FILM_CELL_M,
        "common_cells_xy": FILM_CELLS[:2],
        "airbox": AIRBOX_RUNTIME,
    },
)

# Re-capture the stage after replacing the imported transfer geometry.  The
# imported stage remains untouched in the source scenario and is not executed.
fm.run(1e-14)
