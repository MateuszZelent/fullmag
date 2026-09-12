"""Run the shared case under a distinct sibling output bundle for FDM GPU."""

from __future__ import annotations

import os
from pathlib import Path
from runpy import run_path


os.environ["FULLMAG_SINC_LAYER_BACKEND"] = "fdm"
os.environ["FULLMAG_FDM_EXECUTION"] = "cuda"
COMMON_CASE = Path(__file__).with_name("fullmag_case.py")
globals().update(run_path(str(COMMON_CASE)))
