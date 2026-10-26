"""Publish the bounded mixed-v2 probe for Inspector QA without running Solve.

Reuse the canonical two-body probe so the browser checks a prism body, a
tetrahedral annulus, and pyramid/tetrahedron air in the production mesh path.
The existing requested device and physical parameters remain explicit in that
source; only its final execution mode is changed before CLI publication.
"""

from pathlib import Path
import runpy

import fullmag as fm


fm.reset()
probe = Path(__file__).resolve().parents[1] / "examples" / "fem_disconnected_mixed_p1_operator_probe.py"
study = runpy.run_path(str(probe))["study"]
study.interactive(True)
study.wait_for_solve(True)
