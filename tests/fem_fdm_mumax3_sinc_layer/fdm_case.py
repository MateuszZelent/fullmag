"""Run the shared case under a distinct sibling output bundle for FDM."""

from pathlib import Path
from runpy import run_path


COMMON_CASE = Path(__file__).with_name("fullmag_case.py")
globals().update(run_path(str(COMMON_CASE)))
