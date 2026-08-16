from __future__ import annotations

import json
import shutil
from pathlib import Path

from scripts.test_build_skyrmion_hall_artifact import _write_stage
from scripts.collect_fdm_gpu_racetrack_evidence import collect_runtime_evidence


def test_missing_drive_is_reported_without_a_qualification_pass(tmp_path: Path) -> None:
    (tmp_path / "stages").mkdir()
    evidence = collect_runtime_evidence(tmp_path, tmp_path / "evidence")

    assert evidence["status"] == "blocked"
    assert "missing_drive_minus_1_5" in evidence["reason_codes"]
    assert evidence["qualification_manifest_status"] == "not_created_by_collector"


def test_partial_runtime_writes_hall_artifact_and_remains_fail_closed(tmp_path: Path) -> None:
    session = tmp_path / "session" / "stages"
    stage = _write_stage(tmp_path / "fixture-stage", sample_count=2)
    target = session / "stage_01_flat_run"
    target.parent.mkdir(parents=True)
    shutil.copytree(stage, target)

    evidence = collect_runtime_evidence(session.parent, tmp_path / "evidence")

    assert evidence["status"] == "blocked"
    drive = next(item for item in evidence["drives"] if item["drive_id"] == "drive_solved_current_plus_1_5")
    assert drive["hall_angle"]["reason_code"] == "insufficient_samples"
    hall_path = tmp_path / "evidence" / drive["hall_angle"]["artifact"]
    assert hall_path.is_file()
    assert json.loads(hall_path.read_text(encoding="utf-8"))["schema_version"] == "skyrmion_hall_angle.v1"
    assert "missing_drive_minus_1_5" in evidence["reason_codes"]


def test_final_artifact_root_is_considered_when_live_stage_directory_is_absent(tmp_path: Path) -> None:
    session = tmp_path / "session"
    (session / "stages").mkdir(parents=True)
    stage = _write_stage(tmp_path / "final-stage", sample_count=2)
    shutil.copytree(stage, session, dirs_exist_ok=True)
    metadata = json.loads((session / "metadata.json").read_text(encoding="utf-8"))
    metadata["status"] = "completed"
    (session / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    evidence = collect_runtime_evidence(session, tmp_path / "evidence")

    drive = next(item for item in evidence["drives"] if item["drive_id"] == "drive_solved_current_plus_1_5")
    assert drive["status"] == "completed"
    assert drive["stage_dir"] == "."


def test_separate_artifact_root_can_supply_the_final_flat_run(tmp_path: Path) -> None:
    session = tmp_path / "session"
    stages = session / "stages"
    stages.mkdir(parents=True)
    artifact_root = _write_stage(tmp_path / "artifact-root", sample_count=2)
    metadata = json.loads((artifact_root / "metadata.json").read_text(encoding="utf-8"))
    metadata["status"] = "completed"
    (artifact_root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (artifact_root / "states").mkdir()
    (artifact_root / "states/relaxed_zero_current.json").write_text("{}", encoding="utf-8")
    (stages / "stage_00_flat_save_state").mkdir()
    (stages / "stage_00_flat_save_state/synthetic_stage.json").write_text(
        json.dumps(
            {
                "kind": "save_state",
                "stored_path": "/container/run/states/relaxed_zero_current.json",
            }
        ),
        encoding="utf-8",
    )
    (stages / "stage_01_flat_load_state").mkdir()
    (stages / "stage_01_flat_load_state/synthetic_stage.json").write_text(
        json.dumps(
            {
                "kind": "load_state",
                "source_path": "/container/run/states/relaxed_zero_current.json",
            }
        ),
        encoding="utf-8",
    )

    evidence = collect_runtime_evidence(session, tmp_path / "evidence", artifact_root=artifact_root)

    drive = next(item for item in evidence["drives"] if item["drive_id"] == "drive_solved_current_plus_1_5")
    assert drive["status"] == "completed"
    assert evidence["checkpoint_restart"]["save_stages"][0]["exists"] is True


def test_non_normative_completed_drive_is_preserved_as_diagnostic_evidence(tmp_path: Path) -> None:
    session = tmp_path / "session" / "stages"
    stage = _write_stage(tmp_path / "diagnostic-stage", sample_count=2)
    metadata_path = stage / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["problem_meta"]["runtime_metadata"]["active_stage_id"] = (
        "drive_solved_current_plus_1_7"
    )
    metadata["status"] = "completed"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    target = session / "stage_01_flat_run"
    target.parent.mkdir(parents=True)
    shutil.copytree(stage, target)

    evidence = collect_runtime_evidence(session.parent, tmp_path / "evidence")

    assert evidence["status"] == "blocked"
    diagnostic = next(
        item
        for item in evidence["diagnostic_drives"]
        if item["drive_id"] == "drive_solved_current_plus_1_7"
    )
    assert diagnostic["requested_current_Apm2"] == 1.7e12
    assert diagnostic["status"] == "completed"
    assert diagnostic["hall_angle"]["artifact"]
    assert "unexpected_drive_plus_1_7" in evidence["reason_codes"]
