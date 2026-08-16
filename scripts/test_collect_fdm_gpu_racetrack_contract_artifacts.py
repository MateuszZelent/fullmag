from __future__ import annotations

import json
from pathlib import Path

from scripts.collect_fdm_gpu_racetrack_contract_artifacts import collect


def test_raw_artifacts_are_copied_with_hashes_without_proofs(tmp_path: Path) -> None:
    source = tmp_path / "source.json"
    source.write_text('{"status":"pass"}\n', encoding="utf-8")
    root = tmp_path / "evidence"
    result = collect(root, artifacts=(("charge", source),))
    assert result["status"] == "collected"
    record = result["records"][0]
    assert record["status"] == "collected"
    assert (root / record["path"]).is_file()
    assert not (root / "proofs").exists()
    summary = json.loads((root / "fdm_gpu_racetrack_contract_artifacts.v1.json").read_text())
    assert summary["promotion"] == "forbidden_raw_artifacts_only"


def test_missing_raw_artifact_is_blocked_and_never_silently_dropped(tmp_path: Path) -> None:
    root = tmp_path / "evidence"
    result = collect(root, artifacts=(("charge", tmp_path / "missing.json"),))
    assert result["status"] == "blocked"
    assert result["records"][0]["reason_code"] == "source_not_regular_file"
    assert not (root / "proofs").exists()


def test_label_cannot_escape_evidence_root(tmp_path: Path) -> None:
    source = tmp_path / "source.json"
    source.write_text('{"status":"pass"}\n', encoding="utf-8")
    root = tmp_path / "evidence"
    result = collect(root, artifacts=(("../outside", source),))
    assert result["status"] == "blocked"
    assert result["records"][0]["reason_code"] == "label_invalid"
    assert not (tmp_path / "outside").exists()
