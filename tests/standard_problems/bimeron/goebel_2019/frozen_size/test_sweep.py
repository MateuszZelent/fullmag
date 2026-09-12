from __future__ import annotations

import json
from pathlib import Path

from tests.standard_problems.bimeron.goebel_2019.frozen_size import run_sweep


def _layout(root: Path) -> dict[str, object]:
    target = root / "target"
    (target / "x86_64-pc-windows-msvc" / "release").mkdir(parents=True)
    (target / "x86_64-pc-windows-msvc" / "release" / "fullmag.exe").write_bytes(b"binary")
    (root / "windows-runtime").mkdir()
    return {
        "build_root": str(root),
        "env": {"CARGO_TARGET_DIR": str(target)},
    }


def _identity(*, commit: str = "a" * 40, snapshot: str = "b" * 64, dirty: bool = False) -> dict[str, object]:
    return {
        "head_commit_full": commit,
        "source_snapshot_sha256": snapshot,
        "source_snapshot_dirty": dirty,
    }


def test_runtime_manifest_matches_source_and_cuda_policy(tmp_path: Path, monkeypatch) -> None:
    layout = _layout(tmp_path)
    identity = _identity()
    (tmp_path / "windows-runtime" / "build-manifest.json").write_text(
        json.dumps(
            {
                "git_commit": identity["head_commit_full"],
                "source_snapshot_sha256": identity["source_snapshot_sha256"],
                "worktree_state": "clean",
                "cuda": True,
                "local_changes_check": "passed",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(run_sweep, "_source_identity", lambda _repo: identity)

    assert run_sweep._managed_runtime_matches_source(
        tmp_path, layout, device="gpu"
    )

    manifest = json.loads(
        (tmp_path / "windows-runtime" / "build-manifest.json").read_text(encoding="utf-8")
    )
    manifest["git_commit"] = "c" * 40
    (tmp_path / "windows-runtime" / "build-manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    assert not run_sweep._managed_runtime_matches_source(
        tmp_path, layout, device="gpu"
    )


def test_runtime_manifest_rejects_skipped_local_changes(tmp_path: Path, monkeypatch) -> None:
    layout = _layout(tmp_path)
    identity = _identity(dirty=True)
    (tmp_path / "windows-runtime" / "build-manifest.json").write_text(
        json.dumps(
            {
                "git_commit": identity["head_commit_full"],
                "source_snapshot_sha256": identity["source_snapshot_sha256"],
                "worktree_state": "dirty",
                "cuda": False,
                "local_changes_check": "skipped",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(run_sweep, "_source_identity", lambda _repo: identity)

    assert not run_sweep._managed_runtime_matches_source(
        tmp_path, layout, device="cpu"
    )
