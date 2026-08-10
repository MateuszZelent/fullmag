"""SP4-derived B-only control for the real multilayer CPU measurement."""

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.scenario import (
    bottom,
    study,
    top,
)

# Keep both layer carriers in the runtime artifact while making the A source
# negligible.  This is a real solver input, not a post-run field fixture.
bottom.Ms = 1.0e-30
study.runtime_metadata(
    "fdm_multilayer_runtime_control",
    {"case": "b_only", "inactive_layer": "layer_bottom", "inactive_ms_a_per_m": 1.0e-30},
)

# Capture a fresh stage after changing Ms; otherwise the imported base module's
# earlier stage would still carry the original bilayer material state.
fm.run(1e-14)
