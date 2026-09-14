"""Runtime-only benchmark admission retains provenance and CTest separation."""
import json
from pathlib import Path
import sqlite3
from unittest.mock import patch

import pytest
import run_comsol_dispersion_benchmark as benchmark

NATIVE = {"head_commit_full": "a" * 40, "source_snapshot_sha256": "b" * 64}
SOURCE = {"commit": NATIVE["head_commit_full"], "snapshot_sha256": NATIVE["source_snapshot_sha256"]}


def write_attestation(root, **changes):
    value = {"schema": "fullmag.fem.slepc_runtime.attestation.v1", "status": "pass", "source": SOURCE}
    value.update(changes)
    (root / "runtime-attestation.json").write_text(json.dumps(value), encoding="utf-8")


def test_runtime_profile_does_not_claim_or_require_ctest(tmp_path):
    write_attestation(tmp_path)
    assert "contracts/slepc-modal/result.json" not in benchmark.REQUIRED_RUNTIME_ARTIFACTS
    with patch.object(benchmark, "_validate_contract", side_effect=AssertionError("CTest must not run")):
        result = benchmark._validated_build_evidence(tmp_path, benchmark.RUNTIME_PROFILE, NATIVE)
    assert result == {"kind": "native_build_and_runtime_probes", "source": SOURCE}


@pytest.mark.parametrize("changes", [
    {"status": "failed"},
    {"schema": "unknown"},
    {"source": {**SOURCE, "snapshot_sha256": "c" * 64}},
    {"source": {**SOURCE, "commit": "c" * 40}},
])
def test_runtime_evidence_rejects_failed_or_different_source(tmp_path, changes):
    write_attestation(tmp_path, **changes)
    with pytest.raises(benchmark.BenchmarkError):
        benchmark._validated_build_evidence(tmp_path, benchmark.RUNTIME_PROFILE, NATIVE)


def test_existing_modal_profile_still_requires_contract(tmp_path):
    with patch.object(benchmark, "_validate_contract", side_effect=benchmark.BenchmarkError("missing contract")) as validate:
        with pytest.raises(benchmark.BenchmarkError, match="missing contract"):
            benchmark._validated_build_evidence(tmp_path, benchmark.PROFILE, NATIVE)
        validate.assert_called_once()


@pytest.mark.parametrize("profile,accepted", [
    (benchmark.RUNTIME_PROFILE, True),
    (benchmark.PROFILE, True),
    ("fem-cpu-release", False),
    ("fem-gpu-release", False),
    ("unknown", False),
])
def test_job_reader_admits_only_completed_slepc_profiles(tmp_path, profile, accepted):
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "index").mkdir()
    job_id, capture_id = "d" * 32, "e" * 32
    payload = {
        "origin_repo": str(repo), "capture_id": capture_id,
        "capsule_relative": f"runs/worktree-a/{capture_id}/source",
        "native_source_identity": {"schema": "fullmag.source-snapshot.v2", **NATIVE},
    }
    with sqlite3.connect(tmp_path / "index/runner-jobs.sqlite") as db:
        db.execute("CREATE TABLE jobs (job_id TEXT, owner TEXT, worktree_id TEXT, source_digest TEXT, profile TEXT, operation TEXT, payload TEXT, state TEXT, exit_code INTEGER)")
        db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)", (job_id, "operator", "worktree-a", "f" * 64, profile, "build", json.dumps(payload), "succeeded", 0))
    layout = {"storage_root": str(tmp_path), "repo_root": str(repo), "worktree_id": "worktree-a"}
    if accepted:
        assert benchmark._read_job(layout, job_id)["profile"] == profile
    else:
        with pytest.raises(benchmark.BenchmarkError, match="profile"):
            benchmark._read_job(layout, job_id)
    with sqlite3.connect(tmp_path / "index/runner-jobs.sqlite") as db:
        db.execute("UPDATE jobs SET state='failed', exit_code=1")
    with pytest.raises(benchmark.BenchmarkError):
        benchmark._read_job(layout, job_id)
