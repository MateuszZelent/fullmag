from __future__ import annotations

import json
from pathlib import Path

from tests.standard_problems.bimeron.goebel_2019.frozen_size.report import (
    free_reference_from_analysis,
    render_report,
)
from tests.standard_problems.bimeron.goebel_2019.frozen_size.provenance import build_contract


def _free_contract() -> dict[str, object]:
    return build_contract(
        case={
            "case_id": "free-reference-p0",
            "target_radius_nm": 3.0,
            "preset_radius_nm": 2.0,
            "wall_width_nm": 3.0,
            "protocol": "p0",
            "cell_nm": 0.5,
            "pin_radius_nm": 0.5,
            "ring_width_nm": 0.5,
            "helicity_rad": 0.0,
            "vorticity": -1,
            "background_sign": 1,
            "release": False,
        },
        environment={
            "FULLMAG_BIMERON_MSAT_A_PER_M": "580000",
            "FULLMAG_BIMERON_AEX_J_PER_M": "1.5e-11",
            "FULLMAG_BIMERON_D_J_PER_M2": "0.004",
            "FULLMAG_BIMERON_KU_J_PER_M3": "800000",
            "FULLMAG_BIMERON_TRACK_X_NM": "100",
            "FULLMAG_BIMERON_TRACK_Y_NM": "80",
            "FULLMAG_BIMERON_CELL_NM": "0.5",
            "FULLMAG_BIMERON_DEVICE": "gpu",
            "FULLMAG_BIMERON_DT_S": "1e-14",
            "FULLMAG_BIMERON_ALPHA": "1",
            "FULLMAG_BIMERON_TOL_T": "0.005",
            "FULLMAG_BIMERON_RELAX_TIME_S": "3e-11",
            "FULLMAG_BIMERON_HOLD_TIME_S": "2e-12",
            "FULLMAG_BIMERON_RELEASE_TIME_S": "2e-11",
            "FULLMAG_BIMERON_RELAX_MAX_STEPS": "3000",
            "FULLMAG_BIMERON_RELEASE_MAX_STEPS": "8000",
            "FULLMAG_BIMERON_FIELD_EVERY_STEPS": "1000",
            "FULLMAG_BIMERON_TABLE_EVERY_STEPS": "500",
            "FULLMAG_BIMERON_RELAX_ALGORITHM": "llg_overdamped",
        },
        source={
            "profile": "bimeron-rdmi-frozen-spins",
            "source_identity": {
                "head_commit_full": "a" * 40,
                "source_snapshot_sha256": "b" * 64,
                "source_snapshot_dirty": False,
            },
            "scripts": {"scenario": {"sha256": "c" * 64}},
        },
        thresholds_sha256="d" * 64,
        kind="free_reference",
    )


def test_report_keeps_non_converged_points_out_of_accepted_curve(tmp_path: Path) -> None:
    case_root = tmp_path / "case"
    case_root.mkdir()
    (case_root / "verification.json").write_text(
        json.dumps({"status": "not_converged", "failures": [], "warnings": []}),
        encoding="utf-8",
    )
    summary = {
        "schema_version": "bimeron_frozen_size.sweep.v1",
        "background": {"analysis": "background/analysis.json"},
        "results": [
            {
                "artifact_root": str(case_root),
                "protocol": {
                    "case_id": "R3-p3",
                    "target_radius_nm": 3.0,
                    "preset_radius_nm": 1.75,
                    "wall_width_nm": 3.0,
                    "protocol": "p3",
                    "cell_nm": 0.5,
                },
                "profile_energy": {
                    "stage_id": "constrained_hold",
                    "E_total_J": -1.0,
                    "delta_E_to_background_J": 0.1,
                    "E_ex_J": 0.2,
                    "E_rotated_dmi_J": -0.3,
                    "E_ani_J": -0.9,
                    "E_demag_J": 0.0,
                },
                "states": {
                    "constrained_held": {
                        "measurement": {
                            "R_area_nm": 3.0,
                            "topological_charge": -1.0,
                        }
                    },
                    "released": {"measurement": {"R_core_nm": 2.8}},
                },
                "frozen_runtime": {
                    "frozen_dof_count": 12,
                    "free_dof_count": 8,
                    "frozen_mask_sha256": "mask",
                    "frozen_reference_sha256": "reference",
                    "frozen_selector_sha256": "selector",
                },
            }
        ],
    }

    report = render_report(summary)

    assert "No point is classified as an accepted minimum curve point" in report
    assert "| 3 | 3 | 2.8 | -1 |" in report
    assert "| not_converged | not_converged |" in report


def test_report_includes_optional_free_control(tmp_path: Path) -> None:
    analysis = tmp_path / "free-analysis.json"
    analysis.write_text(
        json.dumps(
            {
                "status": "measured",
                "profile_energy": {"E_total_J": -8.1e-18},
                "protocol": {"protocol": "p0"},
                "runtime_provenance": {"completion": {"converged": True}},
                "provenance_contract": _free_contract(),
                "states": {
                    "constrained_held": {
                        "measurement": {
                            "R_area_nm": 2.62,
                            "R_core_nm": 2.75,
                            "topological_charge": -1.0,
                            "max_unit_norm_defect": 0.0,
                        }
                    }
                },
                "frozen_runtime": {"frozen_dof_count": 0},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "verification.json").write_text(
        json.dumps({"status": "passed"}), encoding="utf-8"
    )
    summary = {
        "schema_version": "bimeron_frozen_size.sweep.v1",
        "background": {"status": "usable", "energy_J": -8.3e-18},
        "results": [],
        "free_reference": free_reference_from_analysis(analysis),
    }

    report = render_report(summary)

    assert "## Free-relaxation control" in report
    assert "| 2.62 | 2.75 | -1 |" in report
    assert "-8.100000e-18" in report


def test_free_reference_rejects_unprovenanced_analysis(tmp_path: Path) -> None:
    analysis = tmp_path / "free-analysis.json"
    analysis.write_text(
        json.dumps(
            {
                "status": "measured",
                "protocol": {"protocol": "p0"},
                "runtime_provenance": {"completion": {"converged": True}},
                "profile_energy": {"E_total_J": -1.0},
                "states": {
                    "constrained_held": {"measurement": {"R_area_nm": 3.0}}
                },
            }
        ),
        encoding="utf-8",
    )

    import pytest

    with pytest.raises(ValueError, match="provenance evidence"):
        free_reference_from_analysis(analysis)
