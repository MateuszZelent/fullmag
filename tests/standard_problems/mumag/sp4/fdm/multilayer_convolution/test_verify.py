"""Contract tests for the SP4-derived FDM multilayer qualification scaffold."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
VERIFY = ROOT / "verify.py"


def test_verifier_accepts_the_frozen_sp4_derived_scenario_contract() -> None:
    result = subprocess.run(
        [sys.executable, str(VERIFY)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["schema_version"] == "sp4_fdm_multilayer_qualification.v1"
    assert report["qualification_scope"] == (
        "SP4-derived, not canonical SP4 qualification"
    )
    assert report["runtime_qualification"] == "not_run"
    assert report["bilayer"]["center_separation_nm"] == 9.0
    assert report["bilayer"]["vacuum_gap_nm"] == 6.0
    assert report["bilayer"]["inter_object_exchange"] == "disabled"
    assert report["airbox"]["published_quantities"] == ["H_demag"]
    assert report["airbox"]["unavailable_quantities"] == {
        "H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"
    }


def test_verifier_reports_every_frozen_starting_threshold() -> None:
    result = subprocess.run(
        [sys.executable, str(VERIFY)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    thresholds = report["thresholds"]
    assert thresholds["cpu_fp64_vs_direct"]["rtol"] == 1e-10
    assert thresholds["cpu_fp64_vs_direct"]["atol_a_per_m"] == 1e-6
    assert thresholds["cuda_fp64_vs_cpu"]["rtol"] == 1e-8
    assert thresholds["cuda_fp32_vs_cuda_fp64"]["weighted_rms_max"] == 2e-4
    assert thresholds["transfer_moment_residual"]["fp64"] == 1e-12
    assert thresholds["energy_finite_difference_residual"]["fp32"] == 5e-4
    assert thresholds["field_floor"] == "max(1 A/m, 1e-8*H_scale)"
