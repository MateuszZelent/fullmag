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
    assert report["bilayer"]["scope"] == "bilayer_coupling"
    assert report["bilayer"]["runtime_qualification"] == "not_run"
    assert report["bilayer"]["cross_layer_checks"] == [
        "H_A<-B = H_A(A+B)-H_A(A)",
        "source_sign_flip",
        "zero_pair_kernel_negative_control",
    ]
    assert report["airbox"]["scope"] == "airbox_observation"
    assert report["airbox"]["runtime_qualification"] == "not_run"
    assert report["airbox"]["target_only"] is True
    assert report["airbox"]["coordinate_system"] == "cartesian_si"
    assert report["airbox"]["origin_rule"]
    assert report["airbox"]["cell_center_rule"]
    assert report["airbox"]["padding_rule"]
    assert report["airbox"]["sample_rule"]


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
    assert thresholds["cpu_fp64_vs_direct"]["norm"] == "relative_linf_with_absolute_floor"
    assert thresholds["cpu_fp64_vs_direct"]["rtol_unit"] == "1"
    assert thresholds["cpu_fp64_vs_direct"]["atol_unit"] == "A/m"
    assert thresholds["cpu_fp64_vs_direct"]["rtol"] == 1e-10
    assert thresholds["cpu_fp64_vs_direct"]["atol"] == 1e-6
    assert thresholds["cuda_fp64_vs_cpu"]["norm"] == "relative_linf_with_absolute_floor"
    assert thresholds["cuda_fp64_vs_cpu"]["rtol"] == 1e-8
    assert thresholds["cuda_fp32_vs_cuda_fp64"]["norm"] == "weighted_rms_and_component_linf"
    assert thresholds["cuda_fp32_vs_cuda_fp64"]["weighted_rms_unit"] == "1"
    assert thresholds["cuda_fp32_vs_cuda_fp64"]["max_component_normalized"] == 5e-4
    assert thresholds["transfer_moment_residual"]["norm"] == "relative_l2"
    assert thresholds["transfer_moment_residual"]["unit"] == "1"
    assert thresholds["transfer_moment_residual"]["fp64"] == 1e-12
    assert thresholds["energy_finite_difference_residual"]["norm"] == "relative_absolute_residual"
    assert thresholds["energy_finite_difference_residual"]["unit"] == "1"
    assert thresholds["energy_finite_difference_residual"]["fp32"] == 5e-4
    assert thresholds["field_floor"]["norm"] == "max"
    assert thresholds["field_floor"]["unit"] == "A/m"
    assert thresholds["field_floor"]["expression"] == "max(1 A/m, 1e-8*H_scale)"


def test_verifier_freezes_the_canonical_sp4_material_dynamics_and_cases() -> None:
    result = subprocess.run(
        [sys.executable, str(VERIFY)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["canonical_sp4"]["ms_a_per_m"] == 8e5
    assert report["canonical_sp4"]["aex_j_per_m"] == 1.3e-11
    assert report["canonical_sp4"]["alpha"] == 0.02
    assert report["canonical_sp4"]["gamma_mu0_m_per_as"] == 2.211e5
    assert report["canonical_sp4"]["initial_m"] == [
        0.9950371902099893,
        0.09950371902099893,
        0.0,
    ]
    assert report["canonical_sp4"]["cases"] == [
        {"id": "case-a", "field_t": [-0.0246, 0.0043, 0.0]},
        {"id": "case-b", "field_t": [-0.0355, -0.0063, 0.0]},
    ]
    assert report["canonical_sp4"]["dimensions_m"] == [500e-9, 125e-9, 3e-9]
    assert report["canonical_sp4"]["sample_period_s"] == 1e-12
    assert report["canonical_sp4"]["minimum_duration_s"] == 1e-9
    assert report["canonical_sp4"]["equilibrium_window_s"] == 50e-12
    assert report["canonical_sp4"]["maximum_duration_s"] == 5e-9
    assert report["canonical_sp4"]["meshes"] == [
        {"id": "coarse", "hmax_m": 3e-9},
        {"id": "medium", "hmax_m": 2e-9},
        {"id": "fine", "hmax_m": 1.5e-9},
    ]
    assert report["canonical_sp4"]["airboxes"] == [
        {"id": "baseline", "dimensions_m": [700e-9, 250e-9, 250e-9], "hmax_m": 20e-9},
        {"id": "expanded", "dimensions_m": [1000e-9, 500e-9, 500e-9], "hmax_m": 20e-9},
    ]
    assert report["airbox"]["sample_anchor_indices"] == [
        {"location": "center", "index_ij": [64, 16]},
        {"location": "long_edge", "index_ij": [64, 31]},
        {"location": "short_edge", "index_ij": [127, 16]},
    ]
    assert report["airbox"]["sample_anchor_rule"]
