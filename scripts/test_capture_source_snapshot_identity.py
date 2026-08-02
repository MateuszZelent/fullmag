from __future__ import annotations

import json
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / "scripts/capture_source_snapshot_identity.py"


def _git(repo: Path, *arguments: str) -> None:
    subprocess.run(("git", *arguments), cwd=repo, check=True, capture_output=True)


def _repository(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Source Identity Test")
    _git(repo, "config", "user.email", "source-identity@example.invalid")
    (repo / "tracked.txt").write_text("committed\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-qm", "initial")
    return repo


def _submodule_repository(tmp_path: Path) -> Path:
    submodule = tmp_path / "submodule"
    submodule.mkdir()
    _git(submodule, "init", "-q")
    _git(submodule, "config", "user.name", "Source Identity Submodule")
    _git(submodule, "config", "user.email", "source-identity-submodule@example.invalid")
    (submodule / "tracked.txt").write_text("submodule\n", encoding="utf-8")
    _git(submodule, "add", "tracked.txt")
    _git(submodule, "commit", "-qm", "initial submodule")
    return submodule


def _materialize(repo: Path, snapshot: Path, identity_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--output",
            str(identity_path),
            "--materialize",
            str(snapshot),
        ),
        text=True,
        capture_output=True,
        check=False,
    )


def test_capture_records_full_commit_and_exact_dirty_content(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    (repo / "tracked.txt").write_text("dirty tracked\n", encoding="utf-8")
    (repo / "untracked.txt").write_text("dirty untracked\n", encoding="utf-8")

    result = subprocess.run(
        (sys.executable, str(CAPTURE), "--repo-root", str(repo)),
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    identity = json.loads(result.stdout)
    assert len(identity["head_commit_full"]) == 40
    assert identity["source_snapshot_dirty"] is True
    assert len(identity["dirty_content_sha256"]) == 64
    assert len(identity["source_snapshot_sha256"]) == 64
    assert {entry["path"] for entry in identity["dirty_path_content"]} == {
        "tracked.txt",
        "untracked.txt",
    }


def test_capture_ignores_dirty_gitlink_worktree(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    submodule = _submodule_repository(tmp_path)
    _git(repo, "-c", "protocol.file.allow=always", "submodule", "add", str(submodule), "external_solvers/3")
    _git(repo, "commit", "-qm", "add external solver submodule")
    (repo / "external_solvers/3/tracked.txt").write_text("dirty submodule\n", encoding="utf-8")

    result = subprocess.run(
        (sys.executable, str(CAPTURE), "--repo-root", str(repo)),
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    identity = json.loads(result.stdout)
    assert identity["source_snapshot_dirty"] is False
    assert identity["dirty_path_content"] == []


def test_compare_fails_when_dirty_content_changes_after_capture(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    tracked = repo / "tracked.txt"
    tracked.write_text("first dirty state\n", encoding="utf-8")
    identity_path = tmp_path / "identity.json"
    first = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--output",
            str(identity_path),
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    assert first.returncode == 0, first.stderr
    tracked.write_text("second dirty state\n", encoding="utf-8")

    compared = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--compare",
            str(identity_path),
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert compared.returncode == 2
    assert "source identity changed during managed FEM runtime build" in compared.stderr


def test_compare_can_warn_when_worktree_changes_during_build(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    identity_path = tmp_path / "identity.json"
    snapshot = tmp_path / "snapshot"
    captured = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--output",
            str(identity_path),
            "--materialize",
            str(snapshot),
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    assert captured.returncode == 0, captured.stderr
    (repo / "tracked.txt").write_text("changed while build runs\n", encoding="utf-8")

    compared = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--compare",
            str(identity_path),
            "--allow-source-drift",
            "--verify-materialized",
            str(snapshot),
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert compared.returncode == 0, compared.stderr
    assert "SOURCE_IDENTITY_WARNING=source identity changed during managed FEM runtime build" in compared.stderr


def test_snapshot_verification_does_not_read_live_worktree_after_capture(
    tmp_path: Path,
) -> None:
    repo = _repository(tmp_path)
    identity_path = tmp_path / "identity.json"
    snapshot = tmp_path / "snapshot"
    captured = _materialize(repo, snapshot, identity_path)
    assert captured.returncode == 0, captured.stderr

    (repo / "tracked.txt").write_text("changed while build runs\n", encoding="utf-8")

    verified = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--compare",
            str(identity_path),
            "--verify-materialized-snapshot",
            str(snapshot),
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert verified.returncode == 0, verified.stderr


def test_runtime_snapshot_ignores_non_runtime_dirty_paths_during_materialization(
    tmp_path: Path,
) -> None:
    repo = _repository(tmp_path)
    docs = repo / "docs"
    docs.mkdir()
    (docs / "notes.md").write_text("committed docs\n", encoding="utf-8")
    _git(repo, "add", "docs/notes.md")
    _git(repo, "commit", "-qm", "add docs")
    (docs / "notes.md").write_text("first docs edit\n", encoding="utf-8")
    identity_path = tmp_path / "runtime-identity.json"
    snapshot = tmp_path / "runtime-snapshot"

    captured = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--ignore-non-runtime-dirty",
            "--output",
            str(identity_path),
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    assert captured.returncode == 0, captured.stderr
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    assert identity["dirty_path_content"] == []
    assert identity["source_snapshot_dirty"] is False

    (docs / "notes.md").write_text("second docs edit\n", encoding="utf-8")
    materialized = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--ignore-non-runtime-dirty",
            "--compare",
            str(identity_path),
            "--materialize",
            str(snapshot),
            "--materialize-existing-empty",
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert materialized.returncode == 0, materialized.stderr


def test_successful_compare_is_silent(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    identity_path = tmp_path / "identity.json"
    subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--output",
            str(identity_path),
        ),
        check=True,
        capture_output=True,
        text=True,
    )

    compared = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--compare",
            str(identity_path),
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert compared.returncode == 0, compared.stderr
    assert compared.stdout == ""


def test_snapshot_identity_binds_normalized_dirty_file_mode(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    tracked = repo / "tracked.txt"
    tracked.write_text("dirty content\n", encoding="utf-8")

    before = subprocess.run(
        (sys.executable, str(CAPTURE), "--repo-root", str(repo)),
        text=True,
        capture_output=True,
        check=False,
    )
    assert before.returncode == 0, before.stderr
    tracked.chmod(tracked.stat().st_mode | stat.S_IXUSR)
    after = subprocess.run(
        (sys.executable, str(CAPTURE), "--repo-root", str(repo)),
        text=True,
        capture_output=True,
        check=False,
    )

    assert after.returncode == 0, after.stderr
    before_identity = json.loads(before.stdout)
    after_identity = json.loads(after.stdout)
    assert before_identity["schema"] == "fullmag.source-snapshot.v2"
    assert before_identity["dirty_path_content"][0]["mode"] == "100644"
    assert after_identity["dirty_path_content"][0]["mode"] == "100755"
    assert (
        before_identity["source_snapshot_sha256"]
        != after_identity["source_snapshot_sha256"]
    )


def test_snapshot_identity_digest_binds_schema(tmp_path: Path) -> None:
    repo = _repository(tmp_path)
    spec = importlib.util.spec_from_file_location("source_identity_under_test", CAPTURE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    before = module.capture(repo)
    module.SCHEMA = "fullmag.source-snapshot.v999"
    after = module.capture(repo)

    assert before["schema"] != after["schema"]
    assert before["source_snapshot_sha256"] != after["source_snapshot_sha256"]


@pytest.mark.parametrize(
    ("links", "expected_detail"),
    [
        ({"unsafe-link": "/tmp/fullmag-source-outside"}, "absolute"),
        ({"unsafe-link": "../fullmag-source-outside"}, "escapes"),
        (
            {"unsafe-link": "unsafe-chain", "unsafe-chain": "../fullmag-source-outside"},
            "escapes",
        ),
        ({"unsafe-link": "unsafe-loop", "unsafe-loop": "unsafe-link"}, "loop"),
    ],
)
def test_materialize_rejects_unsafe_dirty_symlink_graph(
    tmp_path: Path,
    links: dict[str, str],
    expected_detail: str,
) -> None:
    repo = _repository(tmp_path)
    for name, target in links.items():
        (repo / name).symlink_to(target)

    result = _materialize(repo, tmp_path / "snapshot", tmp_path / "identity.json")

    assert result.returncode == 2
    assert "unsafe source symlink" in result.stderr
    assert expected_detail in result.stderr


@pytest.mark.parametrize(
    ("links", "expected_detail"),
    [
        ({"unsafe-link": "/tmp/fullmag-source-outside"}, "absolute"),
        ({"unsafe-link": "../fullmag-source-outside"}, "escapes"),
        (
            {"unsafe-link": "unsafe-chain", "unsafe-chain": "../fullmag-source-outside"},
            "escapes",
        ),
        ({"unsafe-link": "unsafe-loop", "unsafe-loop": "unsafe-link"}, "loop"),
    ],
)
def test_materialize_rejects_unsafe_committed_symlink_graph(
    tmp_path: Path,
    links: dict[str, str],
    expected_detail: str,
) -> None:
    repo = _repository(tmp_path)
    for name, target in links.items():
        (repo / name).symlink_to(target)
    _git(repo, "add", *links)
    _git(repo, "commit", "-qm", "add unsafe symlink graph")

    result = _materialize(repo, tmp_path / "snapshot", tmp_path / "identity.json")

    assert result.returncode == 2
    assert "unsafe source symlink" in result.stderr
    assert expected_detail in result.stderr


def test_verify_materialized_binds_identity_to_exact_snapshot_content_and_mode(
    tmp_path: Path,
) -> None:
    repo = _repository(tmp_path)
    snapshot = tmp_path / "snapshot"
    identity_path = tmp_path / "identity.json"
    created = _materialize(repo, snapshot, identity_path)
    assert created.returncode == 0, created.stderr
    tracked = snapshot / "tracked.txt"
    tracked.chmod(0o644)
    tracked.write_text("tampered\n", encoding="utf-8")

    verified = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--compare",
            str(identity_path),
            "--verify-materialized",
            str(snapshot),
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert verified.returncode == 2
    assert "materialized source snapshot differs from captured identity" in verified.stderr


def test_materialized_snapshot_is_normalized_and_independent_of_worktree(
    tmp_path: Path,
) -> None:
    repo = _repository(tmp_path)
    tracked = repo / "tracked.txt"
    tracked.write_text("captured tracked\n", encoding="utf-8")
    executable = repo / "tool.sh"
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o751)
    link = repo / "tracked-link"
    link.symlink_to("tracked.txt")
    snapshot = tmp_path / "snapshot"
    identity_path = tmp_path / "identity.json"

    captured = subprocess.run(
        (
            sys.executable,
            str(CAPTURE),
            "--repo-root",
            str(repo),
            "--output",
            str(identity_path),
            "--materialize",
            str(snapshot),
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert captured.returncode == 0, captured.stderr
    assert (snapshot / "tracked.txt").read_text(encoding="utf-8") == "captured tracked\n"
    assert stat.S_IMODE((snapshot / "tracked.txt").stat().st_mode) == 0o444
    assert stat.S_IMODE((snapshot / "tool.sh").stat().st_mode) == 0o555
    assert (snapshot / "tracked-link").is_symlink()
    assert os.readlink(snapshot / "tracked-link") == "tracked.txt"
    assert not (snapshot / ".git").exists()

    tracked.write_text("later mutation\n", encoding="utf-8")
    assert (snapshot / "tracked.txt").read_text(encoding="utf-8") == "captured tracked\n"
