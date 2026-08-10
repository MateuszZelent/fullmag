"""SP4-derived A-only control for the real multilayer CPU measurement."""

import fullmag as fm

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.scenario import (
    bottom,
    study,
    top,
)

# Keep both layer carriers in the runtime artifact while making the B source
# negligible.  This is a real solver input, not a post-run field fixture.
top.Ms = 1.0e-30
study.runtime_metadata(
    "fdm_multilayer_runtime_control",
    {"case": "a_only", "inactive_layer": "layer_top", "inactive_ms_a_per_m": 1.0e-30},
)

# The base module declares a study stage before this control script is loaded.
# Capture a fresh stage after changing Ms so the runner executes this control
# IR rather than the earlier two-layer stage snapshot.
fm.run(1e-14)
