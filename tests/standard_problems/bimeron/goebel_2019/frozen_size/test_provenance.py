from __future__ import annotations

import json
from pathlib import Path

from tests.standard_problems.bimeron.goebel_2019.frozen_size.provenance import (
    build_contract,
    compare_contract,
    contract_missing_evidence,
    load_artifact_contract,
)


def _contract():
    return build_contract(
        case={
            "case_id": "R6-ring",
            "target_radius_nm": 6.0,
            "preset_radius_nm": 5.9,
            "wall_width_nm": 1.5,
            "protocol": "ring",
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
            "FULLMAG_BIMERON_RELAX_ALGORITHM": "llg_overdamped",
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
    )


def test_contract_rejects_missing_source_evidence() -> None:
    contract = _contract()
    incomplete = dict(contract)
    incomplete["physical"] = dict(contract["physical"])
    incomplete["physical"]["source"] = {}
    assert "physical.source.source_identity.head_commit_full" in contract_missing_evidence(incomplete)
    assert compare_contract(contract, incomplete)


def test_physical_contract_ignores_target_radius_but_full_contract_does_not() -> None:
    left = _contract()
    right = _contract()
    right["request"] = dict(left["request"])
    right["request"]["target_radius_nm"] = 8.0
    assert compare_contract(left, right, physical_only=True) == []
    assert compare_contract(left, right)


def test_sidecar_and_analysis_contract_mismatch_is_not_reusable(tmp_path: Path) -> None:
    sidecar = _contract()
    embedded = _contract()
    embedded["request"] = dict(sidecar["request"])
    embedded["request"]["target_radius_nm"] = 7.0
    (tmp_path / "request_contract.json").write_text(json.dumps(sidecar), encoding="utf-8")
    (tmp_path / "analysis.json").write_text(
        json.dumps({"provenance_contract": embedded}), encoding="utf-8"
    )
    assert load_artifact_contract(tmp_path) is None


def test_contract_hash_is_verified() -> None:
    contract = _contract()
    contract["request"] = dict(contract["request"])
    contract["request"]["target_radius_nm"] = 7.0
    assert "contract_sha256_mismatch" in contract_missing_evidence(contract)
