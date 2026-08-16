from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_fdm_gpu_racetrack_qualification.py"
SPEC = importlib.util.spec_from_file_location("racetrack_workload", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
workload = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workload)


def test_command_and_environment_freeze_the_six_drive_workload() -> None:
    env = workload.build_workload_environment({"PATH": "/usr/bin"})
    assert env["FULLMAG_RACETRACK_AMPLITUDES"] == workload.EXACT_AMPLITUDES_ENV
    assert env["FULLMAG_RACETRACK_DRIVE_DURATION"] == "2.0e-9"
    assert env["FULLMAG_RACETRACK_OUTPUT_PERIOD"] == "5.0e-12"
    assert env["FULLMAG_RACETRACK_RELAX_MAX_STEPS"] == "50000"
    assert env["FULLMAG_RACETRACK_RELAX_TOLT"] == "1.0e-6"
    assert env["FULLMAG_ARTIFACT_FIELD_STORAGE"] == "zarr"

    command = workload.build_runtime_command(
        Path("/managed/fullmag"),
        Path("/workspace/examples/fdm_gpu_solved_current_skyrmion_racetrack.py"),
        Path("/reports/workload"),
        Path("/reports/session-history"),
    )
    assert command == [
        "/managed/fullmag",
        "--headless",
        "--json",
        "--backend",
        "fdm",
        "--mode",
        "strict",
        "--precision",
        "double",
        "--output-dir",
        "/reports/workload",
        "--workspace-root",
        "/reports/session-history",
        "/workspace/examples/fdm_gpu_solved_current_skyrmion_racetrack.py",
    ]


def test_conflicting_environment_override_is_rejected() -> None:
    with pytest.raises(workload.WorkloadError, match="FULLMAG_RACETRACK_AMPLITUDES"):
        workload.build_workload_environment(
            {"FULLMAG_RACETRACK_AMPLITUDES": "1.0e12,2.0e12,3.0e12"}
        )
    with pytest.raises(workload.WorkloadError, match="FULLMAG_ARTIFACT_FIELD_STORAGE"):
        workload.build_workload_environment({"FULLMAG_ARTIFACT_FIELD_STORAGE": "json"})


def test_runtime_environment_exposes_the_managed_native_fdm_library(tmp_path: Path) -> None:
    build_root = tmp_path / "managed-build"
    native_fdm = build_root / "native" / "backends" / "fdm"
    native_fdm.mkdir(parents=True)

    environment = workload.build_workload_environment(
        {"LD_LIBRARY_PATH": "/opt/cuda/lib"}, build_root=build_root
    )

    assert environment["LD_LIBRARY_PATH"] == f"{native_fdm}:/opt/cuda/lib"


def test_runtime_environment_rejects_a_missing_managed_native_fdm_library(
    tmp_path: Path,
) -> None:
    with pytest.raises(workload.WorkloadError, match="native_fdm_library_dir_missing"):
        workload.build_workload_environment(build_root=tmp_path / "missing-build")


def test_latest_session_requires_a_real_stages_directory(tmp_path: Path) -> None:
    history = tmp_path / "history"
    old = history / "session-0001"
    old.mkdir(parents=True)
    (old / "stages").mkdir()
    new = history / "session-0002"
    new.mkdir()
    (new / "stages").mkdir()
    (new / "stages" / "stage_01").mkdir()

    assert workload.discover_session_root(history) == new


def test_missing_session_is_fail_closed(tmp_path: Path) -> None:
    with pytest.raises(workload.WorkloadError, match="session_root_missing"):
        workload.discover_session_root(tmp_path / "history")


def test_build_digest_is_independent_of_mount_prefix(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    for root in (first, second):
        (root / "native" / "backends" / "fdm").mkdir(parents=True)
        (root / "fullmag").write_bytes(b"runtime")
        (root / "native" / "backends" / "fdm" / "libfullmag_fdm.so").write_bytes(
            b"native"
        )

    assert workload.build_digest(first / "fullmag", first) == workload.build_digest(
        second / "fullmag", second
    )
