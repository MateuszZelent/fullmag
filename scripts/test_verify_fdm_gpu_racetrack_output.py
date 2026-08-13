from __future__ import annotations

import copy

import pytest

from scripts.verify_fdm_gpu_racetrack_output import validate_output_manifest


def _valid_manifest() -> dict[str, object]:
    revision = "accepted-revision-7"
    return {
        "schema_version": "fullmag.fdm_gpu_solved_current_racetrack_output.v1",
        "requested_execution": {
            "backend": "fdm",
            "device": "gpu",
            "precision": "double",
            "execution_mode": "strict",
        },
        "resolved_execution": {
            "backend": "fdm",
            "device": "gpu",
            "precision": "double",
            "execution_mode": "strict",
            "fallback": "forbidden",
        },
        "relax_zero_current": {
            "status": "accepted",
            "checkpoint": "relaxed_zero_current",
            "accepted_revision": revision,
            "topological_charge": {"status": "accepted", "revision": revision},
        },
        "drive_solved_current": {
            "status": "accepted",
            "cases": [
                {
                    "id": case_id,
                    "current_density_Apm2": current,
                    "restart_revision": revision,
                    "charge_snapshot_revision": revision,
                    "spin_snapshot_revision": revision,
                    "torque_revision": revision,
                }
                for case_id, current in (
                    ("drive_minus_1_5", -1.5e12),
                    ("drive_minus_1_0", -1.0e12),
                    ("drive_minus_0_5", -0.5e12),
                    ("drive_plus_0_5", 0.5e12),
                    ("drive_plus_1_0", 1.0e12),
                    ("drive_plus_1_5", 1.5e12),
                )
            ],
        },
        "fields": {
            field: {"status": "accepted", "revision": revision}
            for field in (
                "m",
                "V_electric",
                "J_charge",
                "spin_potential",
                "spin_current_tensor",
                "torque_stt",
            )
        },
        "analysis": {
            "skyrmion_trajectory": {"status": "accepted", "revision": revision},
            "skyrmion_hall_angle": {"status": "accepted", "revision": revision},
        },
        "qualification_boundary": "not_production_qualified",
    }


def test_output_manifest_accepts_complete_stage_first_solved_current_artifacts() -> None:
    validate_output_manifest(_valid_manifest())


def test_output_manifest_rejects_stale_spin_snapshot() -> None:
    manifest = copy.deepcopy(_valid_manifest())
    manifest["drive_solved_current"]["cases"][0]["spin_snapshot_revision"] = "stale"  # type: ignore[index]

    with pytest.raises(ValueError, match="spin_snapshot_revision"):
        validate_output_manifest(manifest)
