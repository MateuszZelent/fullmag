"""Exercise the real Windows shell boundary without starting a build."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.skipif(os.name != "nt", reason="Windows process command-line regression")
def test_sp4_command_reaches_argument_validation():
    if shutil.which("just") is None:
        pytest.skip("just is unavailable")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            "just", "fullmag", "windows=True", "build=True", "dev", "fem", "gpu",
            "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py",
            "invalid_option=True",
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode != 0
    assert "unknown fullmag option: invalid_option=True" in result.stderr
    assert "unexpected EOF" not in result.stderr
