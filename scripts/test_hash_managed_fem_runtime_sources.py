#!/usr/bin/env python3
"""Tests for managed FEM runtime source provenance hashing."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
HASHER = REPO_ROOT / "scripts" / "hash_managed_fem_runtime_sources.py"


def load_hasher_module():
    spec = importlib.util.spec_from_file_location("managed_fem_source_hash", HASHER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def git(repo: Path, *args: str) -> None:
    completed = subprocess.run(
        ["git", *args], cwd=repo, text=True, capture_output=True, check=False
    )
    assert completed.returncode == 0, completed.stderr


def make_repository(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    (repo / "docker" / "fem-gpu").mkdir(parents=True)
    (repo / "src" / "runtime.txt").write_text("original\n", encoding="utf-8")
    (repo / "justfile").write_text("fixture\n", encoding="utf-8")
    (repo / "docker" / "fem-gpu" / "Dockerfile").write_text(
        "FROM scratch\n", encoding="utf-8"
    )
    inputs = repo / "managed-inputs.txt"
    inputs.write_text("src\n", encoding="utf-8")
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "tests@example.invalid")
    git(repo, "config", "user.name", "Managed runtime tests")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "fixture")
    return repo, inputs


def test_source_inputs_hash_is_stable_when_only_mtime_changes(tmp_path: Path) -> None:
    hasher = load_hasher_module()
    repo, inputs = make_repository(tmp_path)

    first = hasher.collect_source_provenance(repo, inputs)
    os.utime(repo / "src" / "runtime.txt", None)
    second = hasher.collect_source_provenance(repo, inputs)

    assert (
        first["source_provenance"]["source_inputs_sha256"]
        == second["source_provenance"]["source_inputs_sha256"]
    )
    assert first["source_provenance"]["dirty"] is False


def test_source_inputs_hash_changes_when_relevant_file_bytes_change(tmp_path: Path) -> None:
    hasher = load_hasher_module()
    repo, inputs = make_repository(tmp_path)
    clean = hasher.collect_source_provenance(repo, inputs)
    (repo / "src" / "runtime.txt").write_text("modified\n", encoding="utf-8")

    dirty = hasher.collect_source_provenance(repo, inputs, allow_dirty=True)

    assert (
        clean["source_provenance"]["source_inputs_sha256"]
        != dirty["source_provenance"]["source_inputs_sha256"]
    )
    assert dirty["source_provenance"]["dirty"] is True
    assert len(dirty["source_provenance"]["dirty_patch_sha256"]) == 64


def test_dirty_hash_includes_relevant_untracked_files_but_ignores_target_and_fullmag(
    tmp_path: Path,
) -> None:
    hasher = load_hasher_module()
    repo, inputs = make_repository(tmp_path)
    (repo / "target").mkdir()
    (repo / "target" / "ignored.txt").write_text("ignored\n", encoding="utf-8")
    (repo / ".fullmag").mkdir()
    (repo / ".fullmag" / "ignored.txt").write_text("ignored\n", encoding="utf-8")
    before = hasher.collect_source_provenance(repo, inputs)
    (repo / "src" / "untracked.txt").write_text("untracked\n", encoding="utf-8")
    after = hasher.collect_source_provenance(repo, inputs, allow_dirty=True)

    assert before["source_provenance"]["dirty"] is False
    assert after["source_provenance"]["dirty"] is True
    assert after["source_provenance"]["dirty_patch_sha256"] is not None


def test_source_hasher_rejects_relevant_symlink_escaping_repository(tmp_path: Path) -> None:
    hasher = load_hasher_module()
    repo, inputs = make_repository(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")
    (repo / "src" / "escape.txt").symlink_to(outside)
    git(repo, "add", "src/escape.txt")
    git(repo, "commit", "-qm", "escape fixture")

    with pytest.raises(hasher.SourceProvenanceError, match="escapes repository"):
        hasher.collect_source_provenance(repo, inputs)


def test_dirty_relevant_sources_reject_export_without_explicit_opt_in(tmp_path: Path) -> None:
    hasher = load_hasher_module()
    repo, inputs = make_repository(tmp_path)
    (repo / "src" / "runtime.txt").write_text("dirty\n", encoding="utf-8")

    with pytest.raises(
        hasher.SourceProvenanceError, match="FULLMAG_ALLOW_DIRTY_RUNTIME_EXPORT=1"
    ):
        hasher.collect_source_provenance(repo, inputs)
