"""Run the shared case under a distinct output bundle for FEM CPU."""

from __future__ import annotations

from pathlib import Path
from runpy import run_path


COMMON_CASE = Path(__file__).with_name("fullmag_case.py")
globals().update(run_path(str(COMMON_CASE)))
