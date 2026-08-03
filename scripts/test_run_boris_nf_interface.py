from __future__ import annotations

from pathlib import Path

import pytest

from run_boris_nf_interface import (
    _managed_command,
    capture_runtime_identity,
    run_boris_case,
    validate_runtime_identity,
)
from boris_nf_interface_smoke import NfCaseConfig


def _fake_build_root(tmp_path: Path) -> Path:
    build_root = tmp_path / "boris-build"
    build_root.mkdir()
    binary = build_root / "BorisLin"
    binary.write_text("#!/bin/sh\nprintf 'BORIS test version 4\\n'\n", encoding="utf-8")
    binary.chmod(0o755)
    (build_root / "source_manifest.json").write_text(
        '{"schema_version":"fullmag.boris.source.v1","source_manifest_sha256":"fixture"}\n',
        encoding="utf-8",
    )
    return build_root


def test_identity_rejects_missing_binary(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="BorisLin"):
        capture_runtime_identity(tmp_path, "sha256:" + "a" * 64, "cpu")


def test_runner_refuses_nonempty_output(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    (output / "stale.txt").write_text("stale", encoding="utf-8")

    with pytest.raises(RuntimeError, match="non-empty"):
        run_boris_case(NfCaseConfig(output_dir=output), Path("/build"), output, "cpu")


def test_identity_records_binary_and_source_hashes(tmp_path: Path) -> None:
    build_root = _fake_build_root(tmp_path)

    identity = capture_runtime_identity(build_root, "sha256:" + "a" * 64, "cpu")

    assert identity["identity_complete"] is True
    assert len(identity["binary_sha256"]) == 64
    assert len(identity["source_manifest_sha256"]) == 64
    assert identity["device_detected"] == "cpu"


def test_cuda_identity_requires_residency_and_gpu_evidence() -> None:
    with pytest.raises(ValueError, match="compute capability"):
        validate_runtime_identity(
            {
                "schema_version": "fullmag.boris.runtime.v1",
                "identity_complete": True,
                "source_manifest_sha256": "a",
                "binary_sha256": "b",
                "image_digest": "nvidia/cuda@sha256:test",
                "binary_version": "BORIS version 4",
                "python_version": "3.10.12",
                "device_requested": "cuda",
                "device_detected": "RTX",
                "device_residency_evidence": "nvidia-smi",
                "precision": "double",
            }
        )


def test_managed_cpu_command_disables_gpu_and_mounts_report(tmp_path: Path) -> None:
    command = _managed_command(
        tmp_path / "source",
        tmp_path / "report",
        "cpu",
        "nvidia/cuda@sha256:test",
        60,
        None,
    )

    rendered = " ".join(command)
    assert "-g -1" in rendered
    assert f"{(tmp_path / 'report').resolve()}:/report" in rendered
    assert "BorisLin" in rendered
