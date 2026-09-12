"""Run the shared case under a distinct sibling output bundle for FDM CPU."""

import os
from pathlib import Path
from runpy import run_path


os.environ["FULLMAG_SINC_LAYER_BACKEND"] = "fdm"
os.environ["FULLMAG_FDM_EXECUTION"] = "cpu"
COMMON_CASE = Path(__file__).with_name("fullmag_case.py")
globals().update(run_path(str(COMMON_CASE)))
