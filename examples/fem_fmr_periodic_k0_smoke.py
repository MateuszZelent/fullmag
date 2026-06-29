"""Compatibility entrypoint for the periodic k=0 antidot FMR response smoke.

This script intentionally delegates to ``fem_frequency_response_smoke.py``.
The target model is the 200 x 200 x 10 nm Py antidot unit cell with a centered
50 nm hole, x/y PBC, 10 mT in-plane bias, and CPU ``periodic_airbox_k0`` demag
in the driven frequency-response path.

Use ``examples/fem_fmr_free_demag_airbox_smoke.py`` for the separate
free-boundary modal/eigenmode smoke.
"""

from pathlib import Path
import runpy


runpy.run_path(
    str(Path(__file__).with_name("fem_frequency_response_smoke.py")),
    run_name="__main__",
)
