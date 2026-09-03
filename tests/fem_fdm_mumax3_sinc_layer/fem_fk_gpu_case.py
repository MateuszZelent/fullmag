"""Run the shared layer case with the strict device-resident FEM/BEM lane.

The launcher resolves this explicit Fredkin-Koehler request to the GPU
operator and must fail closed if the device operator is unavailable.  It must
never change the request to CPU.
"""

from __future__ import annotations

import os
from pathlib import Path
from runpy import run_path


os.environ["FULLMAG_SINC_LAYER_BACKEND"] = "fem"
os.environ["FULLMAG_FEM_EXECUTION"] = "gpu"
os.environ["FULLMAG_SINC_LAYER_DEMAG"] = "fredkin_koehler"
COMMON_CASE = Path(__file__).with_name("fullmag_case.py")
globals().update(run_path(str(COMMON_CASE)))
