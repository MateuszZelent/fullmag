from __future__ import annotations

import json
import csv
from pathlib import Path

from tests.standard_problems.bimeron.goebel_2019.frozen_size import run_sweep


def test_default_profile_protocols_do_not_repeat_free_relaxation() -> None:
    assert run_sweep.DEFAULT_PROFILE_PROTOCOLS == ("p2", "p3", "ring")


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
        encoding="utf-8-sig",
    )
    monkeypatch.setattr(run_sweep, "_source_identity", lambda _repo: identity)

    assert run_sweep._managed_runtime_matches_source(
        tmp_path, layout, device="gpu"
    )

    manifest = json.loads(
        (tmp_path / "windows-runtime" / "build-manifest.json").read_text(encoding="utf-8-sig")
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


def test_runtime_manifest_distinguishes_headless_frontend_toolchain(
    tmp_path: Path, monkeypatch
) -> None:
    layout = _layout(tmp_path)
    identity = _identity()
    (tmp_path / "windows-runtime" / "build-manifest.json").write_text(
        json.dumps(
            {
                "git_commit": identity["head_commit_full"],
                "source_snapshot_sha256": identity["source_snapshot_sha256"],
                "worktree_state": "clean",
                "cuda": True,
                "local_changes_check": "enforced",
                "node_version": "v24.19.0",
                "pnpm_version": "10.8.1",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(run_sweep, "_source_identity", lambda _repo: identity)

    assert run_sweep._managed_runtime_matches_source(
        tmp_path, layout, device="gpu", needs_control_room_toolchain=True
    )
    assert not run_sweep._managed_runtime_matches_source(
        tmp_path, layout, device="gpu", needs_control_room_toolchain=False
    )


def test_profile_csv_keeps_verification_diagnostics_when_status_is_embedded(tmp_path: Path) -> None:
    case_root = tmp_path / "case"
    case_root.mkdir()
    (case_root / "verification.json").write_text(
        json.dumps(
            {
                "status": "not_converged",
                "radius_error_nm": 0.3,
                "radius_tolerance_nm": 0.25,
                "energy_window_relative_span": 0.002,
                "energy_balance_relative": 1e-12,
            }
        ),
        encoding="utf-8",
    )
    result = {
        "artifact_root": str(case_root),
        "verification_status": "not_converged",
        "protocol": {
            "case_id": "R3-p3",
            "target_radius_nm": 3.0,
            "preset_radius_nm": 1.75,
            "wall_width_nm": 3.0,
            "protocol": "p3",
        },
        "profile_energy": {},
        "energy": {},
        "states": {},
        "frozen_runtime": {},
    }

    output = tmp_path / "profile.csv"
    run_sweep._write_profile_csv(output, [result])
    with output.open(newline="", encoding="utf-8") as stream:
        row = next(csv.DictReader(stream))
    assert row["verification_status"] == "not_converged"
    assert row["radius_error_nm"] == "0.3"
    assert row["radius_tolerance_nm"] == "0.25"
    assert row["energy_window_relative_span"] == "0.002"
    assert row["energy_balance_relative"] == "1e-12"
