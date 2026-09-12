"""Run the shared case under a distinct output bundle for FEM CPU."""

from __future__ import annotations

import os
from pathlib import Path
from runpy import run_path


os.environ["FULLMAG_SINC_LAYER_BACKEND"] = "fem"
os.environ["FULLMAG_FEM_EXECUTION"] = "cpu"
os.environ["FULLMAG_SINC_LAYER_DEMAG"] = "poisson_robin"
COMMON_CASE = Path(__file__).with_name("fullmag_case.py")
globals().update(run_path(str(COMMON_CASE)))
