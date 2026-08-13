"""Behavioral contract for the bounded managed runtime export lock."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORTER = REPO_ROOT / "scripts" / "export_fem_gpu_runtime.sh"


def hold_lock(lock_path: Path, ready_path: Path, seconds: str) -> subprocess.Popen[str]:
    holder = subprocess.Popen(
        [
            "flock",
            "--exclusive",
            str(lock_path),
            "bash",
            "-c",
            'touch "$1"; sleep "$2"',
            "bash",
            str(ready_path),
            seconds,
        ],
        text=True,
    )
    deadline = time.monotonic() + 2
    while not ready_path.exists():
        assert time.monotonic() < deadline, "lock holder did not become ready"
        time.sleep(0.01)
    return holder


def run_exporter(
    repo_root: Path,
    timeout_seconds: str,
    **extra_env: str,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["timeout", "3", "bash", str(EXPORTER)],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "FULLMAG_RUNTIME_PUBLICATION_REPO_ROOT": str(repo_root),
            "FULLMAG_RUNTIME_EXPORT_LOCK_TIMEOUT_SECONDS": timeout_seconds,
            **extra_env,
        },
        text=True,
        capture_output=True,
        check=False,
    )


def test_exporter_fails_closed_with_actionable_timeout_when_lock_is_held(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "repo"
    lock_path = repo_root / ".fullmag/runtimes/.fem-gpu-host.export.v2.lock"
    lock_path.parent.mkdir(parents=True)
    holder = hold_lock(lock_path, tmp_path / "holder-ready", "5")
    try:
        result = run_exporter(repo_root, "0")
    finally:
        holder.terminate()
        holder.wait(timeout=2)

    assert result.returncode == 75, result.stderr
    assert (
        "[export_fem_gpu_runtime] timed out after 0 seconds waiting for managed "
        f"runtime export lock: {lock_path}"
    ) in result.stderr
    assert "retry after the current exporter completes or increase " in result.stderr
    assert "FULLMAG_RUNTIME_EXPORT_LOCK_TIMEOUT_SECONDS" in result.stderr


def test_exporter_acquires_a_lock_released_within_the_deadline(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    lock_path = repo_root / ".fullmag/runtimes/.fem-gpu-host.export.v2.lock"
    lock_path.parent.mkdir(parents=True)
    holder = hold_lock(lock_path, tmp_path / "holder-ready", "0.1")
    try:
        result = run_exporter(repo_root, "2", FULLMAG_RUNTIME_PRUNE="invalid")
    finally:
        holder.wait(timeout=2)

    assert result.returncode == 2, result.stderr
    assert "timed out" not in result.stderr
    assert "FULLMAG_RUNTIME_PRUNE must be 0 or 1" in result.stderr


def test_exporter_rejects_an_invalid_lock_timeout_before_exporting(tmp_path: Path) -> None:
    result = run_exporter(tmp_path / "repo", "-1")

    assert result.returncode == 2, result.stderr
    assert (
        "FULLMAG_RUNTIME_EXPORT_LOCK_TIMEOUT_SECONDS must be a non-negative "
        "integer number of seconds"
    ) in result.stderr
