from __future__ import annotations

import json
from pathlib import Path

import runtime_source_change_policy
from runtime_source_change_policy import is_non_runtime_path, non_runtime_changes_only


def identity(*paths: str) -> dict[str, object]:
    return {
        "head_commit_full": "b" * 40,
        "git_status_porcelain_v1": [{"paths": [path]} for path in paths],
    }


def write_manifest(
    runtime: Path, commit: str = "a" * 40, source_snapshot_sha256: str | None = None
) -> None:
    runtime.mkdir(parents=True)
    build_identity = {"git_commit": commit}
    if source_snapshot_sha256 is not None:
        build_identity["source_snapshot_sha256"] = source_snapshot_sha256
    (runtime / "manifest.json").write_text(
        json.dumps({"build_identity": build_identity}), encoding="utf-8"
    )


def test_non_runtime_path_policy_covers_docs_ci_and_packaging_helpers() -> None:
    assert is_non_runtime_path("public_docs/site/physics.md")
    assert is_non_runtime_path(".github/workflows/release.yml")
    assert is_non_runtime_path("scripts/test_release_workflow_contract.py")
    assert is_non_runtime_path("scripts/export_fem_gpu_runtime.sh")
    assert is_non_runtime_path("justfile")
    assert is_non_runtime_path("scripts/public_docs_information_architecture.py")
    assert not is_non_runtime_path("backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu")


def test_non_runtime_changes_allow_reusing_the_binary(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    write_manifest(runtime)

    repo = tmp_path / "repo"
    repo.mkdir()
    # The helper only needs Git history when the commit changes; use equal commits
    # here to exercise the dirty-worktree policy without creating a repository.
    current = identity("public_docs/site/physics.md", "scripts/prune_managed_fem_runtimes.sh")
    current["head_commit_full"] = "a" * 40

    assert non_runtime_changes_only(repo, current, runtime)


def test_runtime_source_change_rejects_solver_edits(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    write_manifest(runtime)
    repo = tmp_path / "repo"
    repo.mkdir()
    current = identity("backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu")
    current["head_commit_full"] = "a" * 40

    assert not non_runtime_changes_only(repo, current, runtime)


def test_existing_dirty_runtime_file_is_not_rebuilt_when_source_cache_matches(
    tmp_path: Path, monkeypatch
) -> None:
    runtime = tmp_path / "runtime"
    snapshot = "c" * 64
    write_manifest(runtime, source_snapshot_sha256=snapshot)
    repo = tmp_path / "repo"
    repo.mkdir()
    source_cache = tmp_path / "cache"
    cached = source_cache / f"source-cache.{snapshot}"
    (cached / "crates/fullmag-cli/src").mkdir(parents=True)
    (repo / "crates/fullmag-cli/src").mkdir(parents=True)
    content = b"already included in the managed build\n"
    (cached / "crates/fullmag-cli/src/control_room.rs").write_bytes(content)
    (repo / "crates/fullmag-cli/src/control_room.rs").write_bytes(content)
    monkeypatch.setenv("FULLMAG_RUNTIME_SOURCE_CACHE_ROOT", str(source_cache))
    current = identity("crates/fullmag-cli/src/control_room.rs")
    current["head_commit_full"] = "a" * 40

    assert non_runtime_changes_only(repo, current, runtime)

    (repo / "crates/fullmag-cli/src/control_room.rs").write_bytes(b"changed\n")
    assert not non_runtime_changes_only(repo, current, runtime)
