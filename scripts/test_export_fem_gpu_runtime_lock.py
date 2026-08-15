"""Behavioral contract for the bounded managed runtime export lock."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time

import pytest


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


def write_counting_mkdir(path: Path, count_path: Path, nested_started: Path) -> None:
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "count_path=\"${FULLMAG_TEST_MKDIR_COUNT_PATH:?}\"\n"
        "nested_started=\"${FULLMAG_TEST_NESTED_STARTED:?}\"\n"
        "count=0\n"
        "if [ -f \"$count_path\" ]; then count=$(cat \"$count_path\"); fi\n"
        "count=$((count + 1))\n"
        "printf '%s\\n' \"$count\" > \"$count_path\"\n"
        "if [ \"$count\" -gt 1 ]; then\n"
        "  touch \"$nested_started\"\n"
        "  exit \"${FULLMAG_TEST_NESTED_EXIT_STATUS:?}\"\n"
        "fi\n"
        "exec /bin/mkdir \"$@\"\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


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


@pytest.mark.parametrize("nested_exit_status", [74, 75])
def test_exporter_preserves_nested_exporter_status_without_timeout_label(
    tmp_path: Path,
    nested_exit_status: int,
) -> None:
    repo_root = tmp_path / "repo"
    tool_dir = tmp_path / "tools"
    tool_dir.mkdir()
    count_path = tmp_path / "mkdir-count"
    nested_started = tmp_path / "nested-started"
    write_counting_mkdir(tool_dir / "mkdir", count_path, nested_started)

    result = run_exporter(
        repo_root,
        "2",
        PATH=f"{tool_dir}:{os.environ['PATH']}",
        FULLMAG_TEST_MKDIR_COUNT_PATH=str(count_path),
        FULLMAG_TEST_NESTED_STARTED=str(nested_started),
        FULLMAG_TEST_NESTED_EXIT_STATUS=str(nested_exit_status),
    )

    assert result.returncode == nested_exit_status, result.stderr
    assert nested_started.exists()
    assert "timed out" not in result.stderr


def child_pids(pid: int) -> set[int]:
    children_path = Path(f"/proc/{pid}/task/{pid}/children")
    if not children_path.exists():
        return set()
    contents = children_path.read_text(encoding="utf-8").strip()
    return {int(child) for child in contents.split()} if contents else set()


def process_group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


def test_exporter_termination_cancels_its_waiting_lock_child(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    lock_path = repo_root / ".fullmag/runtimes/.fem-gpu-host.export.v2.lock"
    lock_path.parent.mkdir(parents=True)
    holder = hold_lock(lock_path, tmp_path / "holder-ready", "5")
    tool_dir = tmp_path / "tools"
    tool_dir.mkdir()
    count_path = tmp_path / "mkdir-count"
    nested_started = tmp_path / "nested-started"
    write_counting_mkdir(tool_dir / "mkdir", count_path, nested_started)
    exporter = subprocess.Popen(
        ["bash", str(EXPORTER)],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "PATH": f"{tool_dir}:{os.environ['PATH']}",
            "FULLMAG_RUNTIME_PUBLICATION_REPO_ROOT": str(repo_root),
            "FULLMAG_RUNTIME_EXPORT_LOCK_TIMEOUT_SECONDS": "2",
            "FULLMAG_TEST_MKDIR_COUNT_PATH": str(count_path),
            "FULLMAG_TEST_NESTED_STARTED": str(nested_started),
            "FULLMAG_TEST_NESTED_EXIT_STATUS": "75",
        },
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 2
        while not count_path.exists() or count_path.read_text(encoding="utf-8").strip() != "1":
            assert time.monotonic() < deadline, "exporter did not begin lock wait"
            time.sleep(0.01)
        waiter_pid = None
        while waiter_pid is None:
            for child_pid in child_pids(exporter.pid):
                try:
                    child_pgid = os.getpgid(child_pid)
                except ProcessLookupError:
                    continue
                if child_pgid == child_pid:
                    waiter_pid = child_pid
                    break
            assert time.monotonic() < deadline, "exporter did not spawn its lock waiter group"
            time.sleep(0.01)
        waiter_pgid = waiter_pid
        exporter.terminate()
        assert exporter.wait(timeout=2) == 143
    finally:
        holder.terminate()
        holder.wait(timeout=2)

    deadline = time.monotonic() + 1
    while process_group_exists(waiter_pgid) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not Path(f"/proc/{waiter_pid}").exists()
    assert not process_group_exists(waiter_pgid)
    time.sleep(0.25)
    assert not nested_started.exists()


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
